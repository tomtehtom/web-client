import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { writeStructureNBT } from '../src/assignToBlocksForGLB.js';
import { writeStructureGrid } from '../src/structure-export.js';
const grid = side => ({ size: { x: side, y: side, z: side }, palette: ['stone'], data: new Int32Array(side ** 3) });
const small = grid(64), timings = [[], []];
const writers = [writeStructureNBT, writeStructureGrid];
for (let repeat = 0; repeat < 3; repeat++) {
  for (const index of repeat % 2 ? [1, 0] : [0, 1]) {
    global.gc?.(); const start = performance.now(); await writers[index](small); timings[index].push(performance.now() - start);
  }
}
global.gc?.(); const large = grid(100), start = performance.now();
const bytes = await writeStructureGrid(large);
const report = { environment: `Node ${process.version}, desktop CPU; compression included`, comparisonVoxels: small.data.length,
  legacyMs: timings[0], directMs: timings[1], millionVoxelMs: performance.now() - start,
  millionVoxelGzipBytes: bytes.byteLength, millionVoxelRawBytes: gunzipSync(bytes).byteLength };
await mkdir('output/playwright', { recursive: true });
await writeFile('output/playwright/export-benchmark.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
