import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_BLOCK_PALETTE, blockAllowedByPalette, isGravityBlock } from '../src/block-palette.js';
import { SingleSceneFetcher } from '../src/SingleSceneFetcher.js';
import { WorkerVoxelizer } from '../src/voxelizer.worker.js';
import { serializeModel } from '../src/voxelize-model.js';
import * as THREE from 'three';

const atlas = JSON.parse(await readFile(new URL('../public/vanilla.atlas', import.meta.url)));
const names = atlas.blocks.map(block => block.name.replace(/^minecraft:/, ''));
const eligible = names.filter(name => blockAllowedByPalette(name));
assert.equal(eligible.length, 49);
for (const suffix of ['wool', 'concrete', 'terracotta']) {
  assert.equal(eligible.filter(name => name.endsWith(`_${suffix}`)).length, 16);
}
assert.ok(eligible.includes('terracotta'));
assert.equal(names.filter(name => blockAllowedByPalette(name, { ...DEFAULT_BLOCK_PALETTE, glazed: true })).length, 65);
for (const name of ['sand', 'red_sand', 'gravel', 'suspicious_gravel_2', 'suspicious_sand', 'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg', 'scaffolding', 'pointed_dripstone', 'red_concrete_powder']) {
  assert.ok(isGravityBlock(name), name);
  assert.equal(blockAllowedByPalette(name, { wool: true, concrete: true, terracotta: true, glazed: true, other: true }), false, name);
}
assert.ok(!isGravityBlock('soul_sand'));
assert.equal(blockAllowedByPalette('blue_wool', { ...DEFAULT_BLOCK_PALETTE, wool: false }), false);

const realFetch = globalThis.fetch;
try {
  globalThis.fetch = async input => {
    await new Promise(resolve => setTimeout(resolve, 25));
    const name = new URL(input).pathname;
    const root = name.endsWith('root.json')
      ? { geometricError: 100, children: [{ content: { uri: 'branch.json' } }, { content: { uri: 'branch2.json' } }] }
      : { content: { uri: name.replace('.json', '.glb') } };
    return new Response(JSON.stringify({ root }));
  };
  const logs = [];
  const fetcher = new SingleSceneFetcher({ concurrency: 1, progressIntervalMs: 5 });
  const urls = await fetcher.fetch3DTiles(0, 0, null, 1, '', message => logs.push(message), 100, 'https://example.org/root.json');
  assert.equal(urls.length, 2);
  assert.ok(logs.some(message => /Discovering tiles:.*active.*queued.*nodes checked/.test(message)));
  assert.ok(logs.findIndex(message => message.startsWith('Discovering tiles:')) < logs.findIndex(message => message.startsWith('Found')));
  const count = logs.length; await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(logs.length, count, 'Discovery timer must stop after completion');
  globalThis.fetch = async () => new Response(JSON.stringify({ root: {
    geometricError: 4, content: { uri: 'coarse.glb' }, children: [{ geometricError: 0, content: { uri: 'fine.glb' } }],
  } }));
  const capture = threshold => fetcher.fetch3DTiles(0, 0, null, threshold, '', null, 100, 'https://example.org/root.json');
  assert.deepEqual(await capture(20), ['https://example.org/coarse.glb']);
  assert.deepEqual(await capture(1), ['https://example.org/fine.glb']);
  assert.deepEqual(await capture(0), ['https://example.org/fine.glb']);
  globalThis.fetch = async () => new Response(JSON.stringify({ root: {
    geometricError: 0, content: { uri: 'coarse.glb' }, children: [{ geometricError: 0, content: { uri: 'fine.glb' } }],
  } }));
  assert.deepEqual(await capture(0), ['https://example.org/fine.glb'], 'Highest-detail mode descends through zero-error parents');
} finally { globalThis.fetch = realFetch; }

const model = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 2), new THREE.MeshBasicMaterial({ color: 0x808080 }));
const messages = [];
const result = await new WorkerVoxelizer().init({ modelData: serializeModel(model), voxelSize: .5, needGrid: true, renderMode: 'packed', onProgress: message => messages.push(message) });
assert.ok(result.voxelCount > 0);
for (const phase of ['Baking source meshes', 'Voxelizing triangles', 'Sampling occupied voxel colours', 'Building preview mesh', 'Preparing sparse export grid']) {
  assert.ok(messages.some(message => message.startsWith(phase)), `Missing progress phase: ${phase}`);
}
console.log('Palette/progress: all 49 default colours, optional glazed colours, falling-block exclusion, detail traversal, discovery heartbeat cleanup and worker stages passed.');
