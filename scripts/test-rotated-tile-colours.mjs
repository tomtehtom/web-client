import assert from 'node:assert/strict';
import * as THREE from 'three';
import { serializeModel } from '../src/voxelize-model.js';
import { WorkerVoxelizer } from '../src/voxelizer.worker.js';
import { clampSourceAtlasEdges } from '../src/source-textures.js';

function surface(tiled,padded=true) {
  const root=new THREE.Group(),divisions=tiled?2:1,side=16/divisions;
  for(let ty=0;ty<divisions;ty++)for(let tx=0;tx<divisions;tx++) {
    const n=side+1,data=new Uint8Array(n*n*4);
    for(let y=0;y<n;y++)for(let x=0;x<n;x++)data.set([Math.round((tx*side+x)/16*255),Math.round((ty*side+y)/16*255),110,255],(x+y*n)*4);
    const texture=new THREE.DataTexture(data,n,n);texture.colorSpace=THREE.SRGBColorSpace;
    texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
    const geometry=new THREE.PlaneGeometry(side,side);
    if(padded)for(let i=0;i<geometry.attributes.uv.count;i++)geometry.attributes.uv.setXY(i,
      (geometry.attributes.uv.getX(i)*(n-1)+.5)/n,(geometry.attributes.uv.getY(i)*(n-1)+.5)/n);
    const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({map:texture}));
    mesh.position.set(-8+(tx+.5)*side,-8+(ty+.5)*side,0);root.add(mesh);
  }
  return root;
}
async function capture(tiled,angle,method,protect=true,padded=true) {
  const model=surface(tiled,padded);
  if(protect)clampSourceAtlasEdges(model);
  const safePayload=serializeModel(model,{cache:false,preRotateYDeg:angle});
  const result=await new WorkerVoxelizer().init({modelData:safePayload,voxelSize:.5,method,renderMode:'packed',needGrid:true});
  const grid=result.voxelGrid;
  model.traverse(mesh=>{mesh.geometry?.dispose();mesh.material?.map?.dispose();mesh.material?.dispose();});
  return new Map(Array.from(grid.sparse.indices,(index,i)=>[index,grid.sparse.colors[i]]));
}
for(const method of ['3d-sat','2.5d-scan'])for(const angle of [0,15,37]) {
  const whole=await capture(false,angle,method),tiles=await capture(true,angle,method);
  assert.deepEqual([...tiles.keys()].sort((a,b)=>a-b),[...whole.keys()].sort((a,b)=>a-b),'Atlas protection must preserve occupied voxel coverage');
  let large=0,max=0;
  for(const [index,colour]of tiles)if(whole.has(index)) {
    const expected=whole.get(index),error=Math.max(...[0,8,16].map(shift=>Math.abs((colour>>>shift&255)-(expected>>>shift&255))));
    max=Math.max(max,error);if(error>12)large++;
  }
  console.log({method,angle,whole:whole.size,tiles:tiles.size,large,max});
  assert.equal(large,0,'Splitting a smooth surface into tiles must not introduce strongly different seam colours');
}
const unprotected=await capture(true,15,'3d-sat',false,false),protectedTiles=await capture(true,15,'3d-sat',true,false);
assert.ok([...unprotected].some(([i,c])=>protectedTiles.has(i)&&[0,8,16].some(s=>Math.abs((c>>>s&255)-(protectedTiles.get(i)>>>s&255))>50)),
  'Fixture must reproduce the original repeat-edge seam');
for(const mode of ['uv-repeat','texture-repeat','shared-repeat']) {
  const root=surface(false),mesh=root.children[0],texture=mesh.material.map;
  if(mode==='texture-repeat')texture.repeat.x=2;
  else if(mode==='uv-repeat')mesh.geometry.attributes.uv.setX(0,2);
  else {
    const repeated=new THREE.Mesh(mesh.geometry.clone(),mesh.material);
    repeated.geometry.attributes.uv.setX(0,2);root.add(repeated);
  }
  assert.equal(clampSourceAtlasEdges(root),0,'Intentional repeated materials must retain their sampler');
  assert.equal(texture.wrapS,THREE.RepeatWrapping);
  root.traverse(n=>n.geometry?.dispose());texture.dispose();mesh.material.dispose();
}
console.log('Rotated tile seams: original wrap error reproduced; continuous tile colours and coverage preserved at 0°, 15°, 37° in SAT/Scan; intentional/shared repeating textures preserved.');
