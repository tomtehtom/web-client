import { setExportBlockPalette, buildBlockGrid, generateMcfunction, writeStructureNBT, writeSpongeSchem, writeMCEditSchematic } from './assignToBlocksForGLB.js';
import { buildVoxelExportSurface } from './voxel-export-surface.js';
import { writeStructureGrid } from './structure-export.js';

let grid, blocks;
self.onmessage = async ({ data }) => {
  try {
    if (data.grid) { grid = data.grid; blocks = null; }
    if (data.palette) { setExportBlockPalette(data.palette, data.bias); blocks = null; }
    if (!grid) throw new Error('No voxel grid to export');
    self.postMessage({ status: 'progress', message: 'Preparing export…' });
    const start = performance.now();
    const format = data.format;
    if (format !== 'surface-color' && !blocks) blocks = buildBlockGrid(grid, { maxCells: data.maxCells });
    let result;
    if (format.startsWith('surface-')) result = buildVoxelExportSurface(grid, format === 'surface-blocks' ? blocks : null);
    else if (format === 'mcfunction') result = new TextEncoder().encode(generateMcfunction(blocks));
    else if (format === 'nbt') result = await writeStructureGrid(blocks);
    else if (format === 'schem') result = await writeSpongeSchem(blocks);
    else if (format === 'schematic') result = await writeMCEditSchematic(blocks);
    else throw new Error(`Unsupported export format: ${format}`);
    const transfers = result instanceof Uint8Array ? [result.buffer] : result.geometries.flatMap(g =>
      [g.positions.buffer, g.indices.buffer, ...(g.colors8 ? [g.colors8.buffer] : []), ...(g.uv ? [g.uv.buffer] : [])]);
    self.postMessage({ status: 'done', result, elapsedMs: performance.now() - start }, transfers);
  } catch (error) { self.postMessage({ status: 'error', message: error.message }); }
};
