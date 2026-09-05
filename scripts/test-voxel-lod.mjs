import assert from 'node:assert/strict';
import { voxelLodLevels, selectVoxelLod, projectedVoxelDemand, voxelResultBytes, VoxelLodCache } from '../src/voxel-lod.js';

assert.deepEqual(voxelLodLevels(128), [8, 16, 32, 64, 128]);
assert.deepEqual(voxelLodLevels(100), [12.5, 25, 50, 100]);
assert.equal(selectVoxelLod(33, 128), 64);
for (const demand of [29, 33, 31, 38, 30]) assert.equal(selectVoxelLod(demand, 128, 32), 32);
assert.equal(selectVoxelLod(39, 128, 32), 64);
assert.equal(selectVoxelLod(26, 128, 64), 64);
assert.equal(selectVoxelLod(25, 128, 64), 32);
assert.equal(selectVoxelLod(10000, 128, 8), 128);
assert.equal(selectVoxelLod(0, 128, 128), 8);
assert.equal(selectVoxelLod(42, 100, 128), 50);
assert.ok(Math.abs(projectedVoxelDemand(10, 100, 600, 90) - 10) < 1e-10);
assert.equal(projectedVoxelDemand(10, 100, 1200, 90), 2 * projectedVoxelDemand(10, 100, 600, 90));

const shared = new Uint8Array(40), atlas = new Uint8Array(12), grid = new Float32Array(4);
assert.equal(voxelResultBytes({ voxelMesh: { traverse: fn => fn({
  geometry: { index: { array: shared.subarray(0, 4) }, attributes: { a: { array: shared } } },
  material: { uniforms: { atlas: { value: { image: { data: atlas } } } } },
}) }, _voxelGrid: { voxelColors: grid, voxelCounts: new Uint32Array(grid.buffer) } }), 68);

const disposed = new Set(), active = new Map();
const cache = new VoxelLodCache({ maxBytes: 100, maxLevelsPerTile: 3,
  measureBytes: result => result.bytes,
  onActivate: (tile, entry) => { assert.ok(!disposed.has(entry.result)); active.set(tile, entry.result); },
  onDispose: result => { assert.ok(!disposed.has(result), 'double disposal'); disposed.add(result); },
});
const a = {}, b = {};
function build(tile, resolution, signature = 'packed', bytes = 20) {
  const { status, token } = cache.request(tile, resolution, signature);
  assert.equal(status, 'build');
  const result = { bytes };
  assert.equal(cache.stage(token, result), true);
  assert.equal(cache.commit(token), true);
  return result;
}
const coarse = build(a, 16);
assert.equal(cache.request(a, 32, 'packed', { allowBuild: false }).status, 'deferred');
assert.equal(cache.pending(a), null);
const { token: fineJob } = cache.request(a, 64, 'packed');
assert.equal(active.get(a), coarse, 'pending builds preserve the current mesh');
assert.equal(cache.request(a, 64, 'packed').status, 'pending');
let terminated = 0;
cache.setController(fineJob, { terminate: () => terminated++ });
assert.equal(cache.request(a, 16, 'packed').status, 'current');
assert.equal(terminated, 1);
const late = { bytes: 20 };
assert.equal(cache.stage(fineJob, late), false);
assert.ok(disposed.has(late));
assert.equal(cache.commit(fineJob), false);
build(a, 32); build(a, 64);
const buildsBefore = cache.stats().builds;
assert.equal(cache.request(a, 16, 'packed').status, 'cached');
assert.equal(cache.stats().builds, buildsBefore, 'cache hit starts no worker');
assert.equal(active.get(a), coarse);
build(a, 128);
assert.equal(cache.stats().entries, 3);
assert.equal(cache.state(a).levels.has(JSON.stringify(['packed', 32])), false, 'least recently used level evicted');

const held = active.get(a);
cache.invalidate(a);
assert.equal(active.get(a), held);
assert.equal(cache.stats().entries, 1);
const { token: changed } = cache.request(a, 128, 'minecraft');
const staged = { bytes: 20 };
cache.stage(changed, staged);
cache.setVisible(a, false);
assert.ok(disposed.has(staged), 'hidden staged result disposed');
assert.equal(cache.commit(changed), false);
cache.setVisible(a, true);
const { token: retry } = cache.request(a, 128, 'minecraft');
cache.fail(changed);
assert.equal(cache.pending(a), retry, 'old error cannot cancel a newer request');
cache.fail(retry);
assert.equal(active.get(a), held, 'failure preserves displayed mesh');
build(a, 128, 'minecraft', 120);
assert.equal(cache.stats().overBudgetBytes, 20, 'visible active data is protected even above budget');
build(b, 16, 'packed', 40);
assert.equal(cache.stats().bytes, 160);
cache.setVisible(a, false);
assert.equal(cache.current(a), null, 'hidden active data may be evicted');
assert.equal(cache.stats().bytes, 40);
const { token: removed } = cache.request(b, 64, 'packed');
cache.remove(b);
assert.equal(cache.stage(removed, { bytes: 8 }), false);
cache.clear();
assert.equal(cache.stats().bytes, 0);
assert.equal(cache.stats().pending, 0);
assert.equal(cache.stats().tiles, 0);
console.log('Voxel LOD: thresholds, byte accounting, cache reuse, LRU, visibility, cancellation and stale results passed.');
