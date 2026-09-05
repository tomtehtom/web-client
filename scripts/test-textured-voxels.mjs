import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVoxelTextureSampler } from '../src/voxel-texture-sampler.js';
import { serializeModel } from '../src/voxelize-model.js';
import { resolveEarthTileUrl } from '../src/config.js';
import { batchPackedVoxelChunks } from '../src/packed-voxel-batching.js';
import { meshVoxelChunks } from '../src/greedy-mesher.js';
import { decodePackedQuad } from '../src/packed-voxel-format.js';
import { makeStore } from './voxel-fixtures.mjs';
import { fetchEarthResource } from '../src/earth-fetch.js';

const root = 'http://localhost:5173/earth-tiles/v1/3dtiles/root.json';
for (const input of ['/v1/3dtiles/a.glb?s=1', 'a.glb?s=1', 'https://edu.voxelearth.org/v1/3dtiles/a.glb?s=1']) {
  assert.equal(resolveEarthTileUrl(input, root).href, 'http://localhost:5173/earth-tiles/v1/3dtiles/a.glb?s=1');
}
assert.equal(resolveEarthTileUrl('https://example.com/a.glb', root).href, 'https://example.com/a.glb');
let attempts = 0;
assert.equal((await fetchEarthResource(root, {}, async () => ({ status: ++attempts === 1 ? 503 : 200 }), async () => {})).status, 200);
assert.equal(attempts, 2);
attempts = 0;
assert.equal((await fetchEarthResource(root, {}, async () => { attempts++; return { status: 403 }; }, async () => {})).status, 403);
assert.equal(attempts, 1);
const abort = new AbortController(); abort.abort();
await assert.rejects(fetchEarthResource(root, { signal: abort.signal }, async () => { throw new Error('must not run'); }), { name: 'AbortError' });

const store = makeStore(67, 36, 39, (x, y, z) => (x + y + z) % 13 === 0 ? 0 : (0xff000000 | x * 3 | y * 6 << 8 | z * 5 << 16) >>> 0);
const chunks = meshVoxelChunks(store, { packed: true, origin: [-90, 4, 200], voxelSize: 0.25 }).packedChunks;
function expand(chunks) {
  const output = [];
  for (const chunk of chunks) for (let i = 0; i < chunk.quadCount; i++) {
    const q = decodePackedQuad(chunk.quads, i), code = chunk.chunkOffsets?.[i] ?? 0;
    const offset = [code & 1023, (code >>> 10) & 1023, (code >>> 20) & 1023];
    const position = q.position.map((p, d) => chunk.bounds.min[d] + (p + offset[d] * 32) * chunk.voxelSize);
    const colors = q.textured ? [...chunk.atlas.subarray(q.payload * 4, (q.payload + q.width * q.height) * 4)] : q.payload;
    output.push(JSON.stringify({ position, width: q.width, height: q.height, axis: q.axis, sign: q.sign, colors }));
  }
  return output;
}
const batches = batchPackedVoxelChunks(chunks);
assert.equal(batches.length, 1); assert.ok(chunks.length > 4);
assert.deepEqual(expand(batches), expand(chunks), 'Batched positions, colors and face sizes must be exact');
assert.deepEqual(expand(batchPackedVoxelChunks(chunks, 100)), expand(chunks), 'Atlas budget splitting must preserve every face');

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Float32Array([1, 2, 3, 999, 4, 5, 6, 999, 7, 8, 9, 999]), 4), 3, 0));
geometry.setAttribute('uv', new THREE.Uint16BufferAttribute([0, 65535, 32768, 0, 65535, 65535], 2, true));
const model = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
const payload = serializeModel(model);
assert.deepEqual([...payload.meshes[0].geometry.attributes.position.array], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
const uv = payload.meshes[0].geometry.attributes.uv.array;
assert.equal(uv[1], 1); assert.ok(Math.abs(uv[2] - 32768 / 65535) < 1e-7);
geometry.dispose(); model.material.dispose();

// Independent allocating reference, including premultiplied-alpha interpolation.
function reference(image, tex, uv, srgb) {
  let u = uv.x * tex.repeat.x + tex.offset.x, v = uv.y * tex.repeat.y + tex.offset.y;
  if (tex.rotation) {
    u -= tex.center.x; v -= tex.center.y;
    [u, v] = [u * Math.cos(tex.rotation) - v * Math.sin(tex.rotation) + tex.center.x,
      u * Math.sin(tex.rotation) + v * Math.cos(tex.rotation) + tex.center.y];
  }
  const wrap = (x, m) => m === 1000 ? ((x % 1) + 1) % 1 : Math.max(0, Math.min(1, x));
  u = wrap(u, tex.wrapS); v = wrap(v, tex.wrapT); if (tex.flipY) v = 1 - v;
  const x = u * (image.width - 1), y = v * (image.height - 1), x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const out = [0, 0, 0, 0];
  for (const [ix, iy, w] of [[x0, y0, (1 - tx) * (1 - ty)], [Math.min(image.width - 1, x0 + 1), y0, tx * (1 - ty)],
    [x0, Math.min(image.height - 1, y0 + 1), (1 - tx) * ty], [Math.min(image.width - 1, x0 + 1), Math.min(image.height - 1, y0 + 1), tx * ty]]) {
    const at = (iy * image.width + ix) * 4, alpha = image.data[at + 3] / 255;
    for (let c = 0; c < 3; c++) {
      let value = image.data[at + c] / 255;
      if (srgb) value = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      out[c] += value * alpha * w;
    }
    out[3] += alpha * w;
  }
  for (let c = 0; c < 3; c++) out[c] = out[3] > 1e-5 ? out[c] / out[3] : 0;
  return out;
}
let seed = 42;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const image = { width: 7, height: 5, data: Uint8Array.from({ length: 7 * 5 * 4 }, () => Math.floor(random() * 256)) };
for (const srgb of [false, true]) for (const flipY of [false, true]) for (const rotation of [0, 0.4]) for (const wrapS of [1000, 1001]) {
  const tex = { repeat: { x: 1.3, y: 0.7 }, offset: { x: 0.1, y: -0.2 }, center: { x: 0.5, y: 0.5 }, rotation, flipY, wrapS, wrapT: wrapS };
  const sample = createVoxelTextureSampler(image, tex, srgb);
  for (let i = 0; i < 100; i++) {
    const uv = { x: random() * 4 - 2, y: random() * 4 - 2 };
    const expected = reference(image, tex, uv, srgb), actual = sample(uv);
    for (let c = 0; c < 4; c++) assert.ok(Math.abs(expected[c] - actual[c]) < 1e-14);
  }
}
image.data.fill(0);
const tex = { repeat: { x: 1, y: 1 }, offset: { x: 0, y: 0 }, center: { x: 0, y: 0 }, rotation: 0, flipY: false };
assert.deepEqual(createVoxelTextureSampler(image, tex, true)({ x: 0.5, y: 0.5 }), [0, 0, 0, 0]);
console.log('Textured voxels: 3,200 reference samples, alpha, transforms, normalized/interleaved GLTF and streamed URL resolution passed.');
