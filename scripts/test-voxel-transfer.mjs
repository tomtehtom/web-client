import assert from 'node:assert/strict';
import * as THREE from 'three';
import { serializeModel, serializeModelAsync, serializedModelTransfers } from '../src/voxelize-model.js';

// Simulate a pixel view with an offset into a larger allocation. The worker must
// receive just those pixels and take ownership without detaching the source.
const backing = new Uint8Array(24); backing.set([10,20,30,255,40,50,60,255],8);
const pixels = backing.subarray(8,16);
const texture = new THREE.DataTexture(pixels,2,1);
const material = new THREE.MeshBasicMaterial({map:texture});
const geometry = new THREE.BoxGeometry();
const scene = new THREE.Group();
scene.add(new THREE.Mesh(geometry,material),new THREE.Mesh(geometry,material.clone()));
const payload=serializeModel(scene,{cache:false,preRotateYDeg:340});
assert.equal(payload.imageDatas.length,1,'Shared source textures should be decoded/copied once');
const image=payload.imageDatas[0][1];
assert.equal(Object.getPrototypeOf(image),Object.prototype,'Pixel descriptors must be plain transferable objects, not ImageData');
assert.deepEqual([...image.data],[...pixels]);
const transfers=serializedModelTransfers(payload);
assert.equal(new Set(transfers).size,transfers.length);
const received=structuredClone(payload,{transfer:transfers});
assert.ok(transfers.every(buffer=>buffer.byteLength===0),'Every source payload buffer must detach rather than copy');
assert.deepEqual([...received.imageDatas[0][1].data],[10,20,30,255,40,50,60,255]);
assert.equal(pixels.byteLength,8,'Original source textures must remain usable for subsequent rotation rebuilds');
assert.ok(geometry.attributes.position.array.byteLength>0);
for (const angle of [0,340,90,0]) {
  const next=serializeModel(scene,{preRotateYDeg:angle});
  const delivered=structuredClone(next,{transfer:serializedModelTransfers(next)});
  assert.deepEqual([...delivered.imageDatas[0][1].data],[...pixels]);
}
// Large captures must not populate the full-source serialization cache. Changing
// the source bytes between serializations detects a retained cached snapshot.
const largePixels=new Uint8Array(33*1024*1024);
const large=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial({map:new THREE.DataTexture(largePixels,1024,8448)}));
let largePayload=serializeModel(large);
structuredClone(largePayload,{transfer:serializedModelTransfers(largePayload)});
largePixels[0]=239;
largePayload=serializeModel(large);
assert.equal(largePayload.imageDatas[0][1].data[0],239,'Large sources must serialize directly without retaining a second cached copy');
let yielded = false;
setTimeout(()=>{yielded=true;},0);
const asyncPayload=await serializeModelAsync(scene,{cache:false,preRotateYDeg:340,budgetMs:0});
assert.ok(yielded,'Async serialization must let the event loop process input/timers');
assert.deepEqual(asyncPayload,serializeModel(scene,{cache:false,preRotateYDeg:340}),'Cooperative serialization must preserve geometry, transforms and original pixel data');
const abort=new AbortController(); abort.abort(new Error('cancelled'));
await assert.rejects(serializeModelAsync(scene,{signal:abort.signal}),/cancelled/);
console.log('Voxel transfer: plain pixel descriptors, offset views, shared texture deduplication, detached ownership, repeated rotations and large-source cache bypass passed.');
