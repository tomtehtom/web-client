import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { setExportBlockPalette, buildBlockGrid, writeStructureNBT } from '../src/assignToBlocksForGLB.js';
import { writeStructureGrid } from '../src/structure-export.js';
import { buildVoxelExportSurface } from '../src/voxel-export-surface.js';
import { SingleSceneFetcher } from '../src/SingleSceneFetcher.js';

setExportBlockPalette([{ name: 'stone', oklab: { L: .5, a: 0, b: 0 } }]);
const size = 30, counts = new Uint32Array(size ** 3).fill(1), colors = new Float32Array(size ** 3 * 4).fill(.5);
const grid = { gridSize: { x: size, y: size, z: size }, voxelCounts: counts, voxelColors: colors,
  bbox: { min: [-5, 3, 20], max: [10, 18, 35] }, unit: { x: .5, y: .5, z: .5 }, colorSpace: 'srgb' };
const blocks = buildBlockGrid(grid);
assert.equal(blocks.data.length, size ** 3);
const surface = buildVoxelExportSurface(grid, blocks);
assert.equal(surface.stats.triangleCount, 12);
assert.equal(surface.stats.visibleFaceCount, 6 * size ** 2);
assert.equal(surface.geometries[0].groups.length, 1);
assert.equal(Math.max(...surface.geometries[0].uv), size);
assert.equal(Math.min(...surface.geometries[0].uv), -size);
const a = gunzipSync(await writeStructureNBT(blocks)), b = gunzipSync(await writeStructureGrid(blocks));
assert.deepEqual(b, a, 'Streamed Structure NBT must exactly match the existing uncompressed writer');
// Sparse, non-cubic data checks crop offsets, axes and empty cells.
const sparse = { size: { x: 3, y: 2, z: 5 }, palette: ['stone', 'dirt'], data: new Int32Array(30).fill(-1) };
sparse.data[0] = 1; sparse.data[19] = 0; sparse.data[29] = 1;
assert.deepEqual(gunzipSync(await writeStructureGrid(sparse)), gunzipSync(await writeStructureNBT(sparse)));
assert.throws(() => buildBlockGrid(grid, { maxCells: 10 }), /too large/);
const realFetch = globalThis.fetch;
let active = 0, peak = 0;
try {
  globalThis.fetch = async value => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    const url = new URL(value);
    assert.equal(url.searchParams.has('key'), false);
    const root = url.pathname.endsWith('root.json') ? { geometricError: 100, children: Array.from({ length: 8 }, (_, i) => ({ content: { uri: `${i}.json` } })) }
      : { content: { uri: `${url.pathname.split('/').pop().split('.')[0]}.glb` } };
    return new Response(JSON.stringify({ root }), { status: 200 });
  };
  const urls = await new SingleSceneFetcher({ concurrency: 2 }).fetch3DTiles(0, 0, null, 20, '', null, 100, 'https://example.org/root.json');
  assert.equal(peak, 2);
  assert.deepEqual(urls, Array.from({ length: 8 }, (_, i) => `https://example.org/${i}.glb`));
} finally { globalThis.fetch = realFetch; }
console.log('Export: greedy surfaces, repeated UVs, occupied bounds, allocation limit and byte-identical Structure NBT passed.');
