import assert from 'node:assert/strict';
import * as THREE from 'three';
import { serializeModel } from '../src/voxelize-model.js';
import { WorkerVoxelizer } from '../src/voxelizer.worker.js';

// The same flat surface with many small triangles represents ground/roof meshes
// normalized to fit kilometre-wide scenes. Its occupied cells must not disappear
// as triangle area in viewer units shrinks.
async function capture(scale, segments, axis, hitStoreMode='auto') {
  const geometry=new THREE.PlaneGeometry(8,8,segments,segments);
  const material=new THREE.MeshBasicMaterial({color:0x8899aa});
  const mesh=new THREE.Mesh(geometry,material);
  if(axis===0) mesh.rotation.y=Math.PI/2;
  if(axis===1) mesh.rotation.x=Math.PI/2;
  mesh.scale.setScalar(scale);
  const result=await new WorkerVoxelizer().init({modelData:serializeModel(mesh,{cache:false}),voxelSize:.5*scale,
    method:'3d-sat',renderMode:'packed',needGrid:true,hitStoreMode});
  const points=[...result.voxelGrid.sparse.indices].sort((a,b)=>a-b);
  assert.equal(points.length,256,`Complete plane coverage: scale ${scale}, segments ${segments}, axis ${axis}, ${hitStoreMode}`);
  assert.equal(result.voxelCount,256);
  assert.ok(result.packedChunks.length>0);
  geometry.dispose();material.dispose();
  return points;
}
for(const axis of [0,1,2]) {
  const baseline=await capture(1,1,axis);
  for(const scale of [1e-2,1e-4,1e-6]) for(const segments of [1,8,16]) {
    for(const mode of ['dense','sparse']) assert.deepEqual(await capture(scale,segments,axis,mode),baseline,
      'Coverage must be independent of scene normalization, tessellation and hit store');
  }
}
// A 0.5-metre tessellated edge normalized by 1e-4 has cross-product
// length-squared below the old fixed area cutoff despite being valid geometry.
assert.ok((.5e-4)**4 < 1e-12);
console.log('3D SAT coverage: complete ground/roof/wall planes across scales 1 to 1e-6, dense/sparse stores and 1–512 triangles; no normalized small-triangle holes.');
