import { meshVoxelChunks } from './greedy-mesher.js';
import { iterateVoxelSamples } from './assignToBlocksForGLB.js';

// Export ordinary glTF-compatible greedy surfaces, with internal faces removed.
// Preview stays packed; expanded buffers exist only for the duration of export.
export function buildVoxelExportSurface(grid, blockGrid = null) {
  const { x: nx, y: ny, z: nz } = grid.gridSize;
  const sx = Math.ceil(nx / 32), sy = Math.ceil(ny / 32);
  const indexer = { nx, ny, nz, chunkSize: 32, key: (x, y, z) => x + sx * (y + sy * z) };
  const store = { indexer, chunks: new Map() };
  const linear = c => Math.round(255 * (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4));
  const put = (x, y, z, id) => {
    const cx = x >> 5, cy = y >> 5, cz = z >> 5, key = indexer.key(cx, cy, cz);
    let chunk = store.chunks.get(key);
    if (!chunk) { chunk = { cx, cy, cz, data: new Uint32Array(32 ** 3) }; store.chunks.set(key, chunk); }
    chunk.data[(x & 31) + 32 * ((y & 31) + 32 * (z & 31))] = id;
  };
  if (blockGrid) {
    const { size, offset, data } = blockGrid;
    for (let i = 0; i < data.length; i++) if (data[i] >= 0) {
      put(i % size.x + offset.x, Math.floor(i / size.x) % size.y + offset.y,
        Math.floor(i / (size.x * size.y)) + offset.z, 0xff000000 | (data[i] + 1));
    }
  } else {
    iterateVoxelSamples(grid, ({ x, y, z, r, g, b }) => put(x, y, z,
      0xff000000 | linear(r) | (linear(g) << 8) | (linear(b) << 16)));
  }
  const origin = Array.isArray(grid.bbox.min) ? grid.bbox.min : [grid.bbox.min.x, grid.bbox.min.y, grid.bbox.min.z];
  const result = meshVoxelChunks(store, { origin, voxelSize: grid.unit.x });
  if (blockGrid) for (const geometry of result.geometries) {
    const { positions: p, colors8, indices } = geometry;
    const uv = new Float32Array(p.length / 3 * 2), byMaterial = new Map();
    for (let q = 0; q < indices.length / 6; q++) {
      const c = q * 16, base = q * 12;
      const material = (colors8[c] | (colors8[c + 1] << 8) | (colors8[c + 2] << 16)) - 1;
      let list = byMaterial.get(material);
      if (!list) { list = []; byMaterial.set(material, list); }
      for (let i = q * 6; i < q * 6 + 6; i++) list.push(indices[i]);
      const axis = [0, 1, 2].find(d => p[base + d] === p[base + 3 + d] && p[base + d] === p[base + 6 + d]);
      const sign = indices[q * 6 + 1] === q * 4 + 1 ? 1 : -1;
      for (let v = 0; v < 4; v++) {
        const at = base + v * 3, x = Math.round((p[at] - p[base]) / grid.unit.x);
        const y = Math.round((p[at + 1] - p[base + 1]) / grid.unit.x), z = Math.round((p[at + 2] - p[base + 2]) / grid.unit.x);
        const pair = axis === 0 ? [sign * z, y] : axis === 1 ? [x, sign * z] : [sign * x, y];
        uv.set(pair, (q * 4 + v) * 2);
      }
    }
    let at = 0;
    geometry.groups = [];
    for (const [materialIndex, list] of byMaterial) {
      geometry.groups.push({ start: at, count: list.length, materialIndex }); indices.set(list, at); at += list.length;
    }
    geometry.uv = uv; delete geometry.colors8;
  }
  return { geometries: result.geometries, stats: result.meshStats, palette: blockGrid?.palette ?? null };
}
