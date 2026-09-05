import { meshVoxelChunks } from '../src/greedy-mesher.js';
import { makeMillionVoxelFixture } from './voxel-fixtures.mjs';
for (const kind of ['solid', 'terrain', 'colored', 'sparse']) {
  const store = makeMillionVoxelFixture(kind);
  for (const packed of [false, true]) {
  const times = [];
  let result;
  for (let run = 0; run < 4; run++) {
    const start = performance.now();
    result = meshVoxelChunks(store, { packed });
    if (run) times.push(performance.now() - start);
  }
  console.log(JSON.stringify({ fixture: kind, packed, voxels: store.voxelCount, meshMsMedian: times.sort((a, b) => a - b)[1], fullCubeTriangles: store.voxelCount * 12, ...result.meshStats }));
  }
}
