import { BLOCKS, iterateVoxelSamples, rgbToOKLab } from './assignToBlocksForGLB.js';

export const bitCount = mask => {
  let count = 0;
  for (; mask; mask &= mask - 1) count++;
  return count;
};
const linear = c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
const srgb = c => c <= .0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - .055;

// Only horizontal halves are representable. Round up, never cut away source
// samples to approximate a vertical wall with a stair.
export function roundedShapeMask(source, verticalContinuation = false) {
  if (!source) return 0;
  if (verticalContinuation || (source & 0x33) && (source & 0xcc)) return 255;
  return source & 0x33 ? 0x33 : 0xcc;
}

export function fitHalfBlockGrid(grid, materials, { profile = 'balanced', bias = 0, chromaWeight = 2, onProgress = () => {} } = {}) {
  if (grid.exportMetadata?.shapeSampling !== 2) throw new Error('Rebuild with slab height detail enabled before fitting shapes.');
  const candidates = new Map();
  const add = (mask, state, lab) => {
    if (!candidates.has(mask)) candidates.set(mask, []);
    candidates.get(mask).push({ state, lab });
  };
  for (const block of BLOCKS) add(255, block.name, block.oklab);
  for (const material of materials) {
    if (!material.name.endsWith('_slab')) continue;
    const rgb = material.colours[profile] ?? material.colours.balanced;
    const lab = rgbToOKLab(rgb.r, rgb.g, rgb.b);
    for (const { mask, state } of material.variants) if (mask === 0x33 || mask === 0xcc) add(mask, state, lab);
  }
  if (!candidates.has(255) || !materials.length) throw new Error('The Minecraft shape/material palette is unavailable.');
  const size = Object.fromEntries(Object.entries(grid.gridSize).map(([key, value]) => [key, Math.ceil(value / 2)]));
  const cells = new Map();
  onProgress('Grouping half-block samples into 2 × 2 × 2 cells…');
  iterateVoxelSamples(grid, ({ x, y, z, r, g, b }) => {
    const index = Math.floor(x / 2) + size.x * (Math.floor(y / 2) + size.y * Math.floor(z / 2));
    let cell = cells.get(index);
    if (!cell) { cell = [0, 0, 0, 0, 0]; cells.set(index, cell); }
    cell[0] |= 1 << ((x & 1) + 2 * (y & 1) + 4 * (z & 1));
    cell[1] += linear(r); cell[2] += linear(g); cell[3] += linear(b); cell[4]++;
  });
  const indices = new Float64Array(cells.size), colors = new Uint32Array(cells.size), ids = new Uint32Array(cells.size);
  const palette = [], remap = new Map(), cache = new Map();
  const stats = { cells: cells.size, exact: 0, approximated: 0, full: 0, slab: 0, stairs: 0, addedSamples: 0, removedSamples: 0 };
  let at = 0;
  for (const [index, cell] of cells) {
    const [mask, r, g, b, count] = cell;
    const y = Math.floor(index / size.x) % size.y;
    const above = y + 1 < size.y ? cells.get(index + size.x)?.[0] ?? 0 : 0;
    const below = y > 0 ? cells.get(index - size.x)?.[0] ?? 0 : 0;
    // Detect a thin upright feature crossing a cell boundary: an upper sample
    // touches the lower sample directly above (or vice versa) in the same column.
    const verticalContinuation = Boolean(((mask & 0xcc) >> 2) & (above & 0x33)
      || (mask & 0x33) & ((below & 0xcc) >> 2));
    const rounded = roundedShapeMask(mask, verticalContinuation);
    const shape = candidates.has(rounded) ? rounded : 255;
    const rgb = [srgb(r / count), srgb(g / count), srgb(b / count)];
    const key = `${shape}:${rgb.join(',')}`;
    let best = cache.get(key);
    if (!best) {
      const q = rgbToOKLab(...rgb); q.L = Math.max(0, Math.min(1, q.L + bias));
      let distance = Infinity;
      for (const candidate of candidates.get(shape)) {
        const lab = candidate.lab;
        const d = (q.L - lab.L) ** 2 + chromaWeight*((q.a - lab.a) ** 2 + (q.b - lab.b) ** 2);
        if (d < distance) { distance = d; best = { ...candidate, mask: shape }; }
      }
      if (cache.size >= 65536) cache.clear();
      cache.set(key, best);
    }
    const state = best.state;
    let id = remap.get(state);
    if (id === undefined) { id = palette.length; remap.set(state, id); palette.push(state); }
    indices[at] = index; ids[at] = id;
    colors[at++] = 0xff000000 | Math.round(rgb[0]*255) | Math.round(rgb[1]*255)<<8 | Math.round(rgb[2]*255)<<16;
    stats[mask === best.mask ? 'exact' : 'approximated']++;
    stats[best.mask === 255 ? 'full' : state.includes('_slab[') ? 'slab' : 'stairs']++;
    stats.addedSamples += bitCount(best.mask & ~mask); stats.removedSamples += bitCount(mask & ~best.mask);
    if (at % 100000 === 0) onProgress(`Fitting shapes… ${Math.floor(at / cells.size * 100)}%`);
  }
  onProgress(`Shape fit: ${stats.full} full, ${stats.slab} slabs; ${stats.exact} exact, ${stats.approximated} rounded-up cells; no source samples removed.`);
  return { ...grid, gridSize: size, unit: Object.fromEntries(Object.entries(grid.unit).map(([k, v]) => [k, v * 2])),
    colorSpace: 'srgb', sparse: { indices, colors }, fittedStates: { palette, ids },
    exportMetadata: { ...grid.exportMetadata, shapeFit: stats, shapePolicy: 'horizontal-slabs-preserve-vertical', shapeSampling: 1, sampleSpacingMetres: grid.exportMetadata.metersPerBlock / 2 } };
}
