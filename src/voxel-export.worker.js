import { setExportBlockPalette, buildBlockGrid, generateMcfunction, writeStructureNBT, writeMCEditSchematic } from './assignToBlocksForGLB.js';
import { buildVoxelExportSurface } from './voxel-export-surface.js';
import { writeStructureGrid } from './structure-export.js';
import { exportTiledSchematics } from './tiled-export.js';
import { writeCombinedSchematic } from './combined-schematic.js';
import { fitHalfBlockGrid } from './shape-fitting.js';

let grid, blocks, fitted;
self.onmessage = async ({ data }) => {
  try {
    if (data.grid) { grid = data.grid; blocks = null; fitted = null; }
    if (data.palette) { setExportBlockPalette(data.palette, data.bias, data.matchingMode); blocks = null; fitted = null; }
    if (!grid) throw new Error('No voxel grid to export');
    self.postMessage({ status: 'progress', message: 'Preparing export…' });
    const start = performance.now();
    const format = data.format;
    const shapeMode = grid.exportMetadata?.shapeSampling === 2;
    if (shapeMode && format === 'schematic') throw new Error('Slab/stair detail requires modern .schem or .nbt export; legacy MCEdit cannot preserve these states.');
    // GLB intentionally exports the half-block sample preview. Minecraft formats
    // fit those samples back into one block per original metric cell.
    if (shapeMode && !format.startsWith('surface-') && !fitted) fitted = fitHalfBlockGrid(grid, data.shapes,
      { profile: data.profile, bias: data.bias, onProgress: message => self.postMessage({ status: 'progress', message }) });
    const exportGrid = shapeMode && !format.startsWith('surface-') ? fitted : grid;
    if (format === 'schem-zip' || format === 'schem') blocks = null;
    if (!['surface-color', 'schem-zip', 'schem'].includes(format) && (!blocks || shapeMode)) blocks = buildBlockGrid(exportGrid, { maxCells: data.maxCells });
    let result;
    if (format === 'schem-zip') result = await exportTiledSchematics(exportGrid,
      message => self.postMessage({ status: 'progress', message }));
    else if (format.startsWith('surface-')) result = buildVoxelExportSurface(grid, format === 'surface-blocks' ? blocks : null);
    else if (format === 'mcfunction') result = new TextEncoder().encode(generateMcfunction(blocks));
    else if (format === 'nbt') result = await writeStructureGrid(blocks);
    else if (format === 'schem') result = await writeCombinedSchematic(exportGrid,
      message => self.postMessage({ status: 'progress', message }));
    else if (format === 'schematic') result = await writeMCEditSchematic(blocks);
    else throw new Error(`Unsupported export format: ${format}`);
    const transfers = (result.fileParts || result.archiveParts) ? [...new Set((result.fileParts ?? result.archiveParts).map(part => part.buffer))] : result instanceof Uint8Array ? [result.buffer] : result.geometries.flatMap(g =>
      [g.positions.buffer, g.indices.buffer, ...(g.colors8 ? [g.colors8.buffer] : []), ...(g.uv ? [g.uv.buffer] : [])]);
    self.postMessage({ status: 'done', result, elapsedMs: performance.now() - start }, transfers);
  } catch (error) { self.postMessage({ status: 'error', message: error.message }); }
};
