import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVoxelTextureSampler } from '../src/voxel-texture-sampler.js';

// A water chart in the lower-right of an atlas, surrounded by sand. Its UVs
// address texel centres; sampling its left/top edge must not pull in sand.
const width=16,height=16,data=new Uint8Array(width*height*4);
for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set(x>=12&&y>=12?[40,100,100,255]:[218,190,150,255],(x+y*width)*4);
const tex=new THREE.DataTexture(data,width,height);tex.wrapS=tex.wrapT=THREE.ClampToEdgeWrapping;
const sample=createVoxelTextureSampler({data,width,height},tex,false);
for(let y=12;y<16;y++)for(let x=12;x<16;x++) {
  const colour=sample({x:(x+.5)/width,y:(y+.5)/height});
  for(let c=0;c<3;c++)assert.ok(Math.abs(colour[c]-[40,100,100][c]/255)<1e-12,`Atlas bleed at chart edge ${x},${y}, channel ${c}: ${colour}`);
}
tex.dispose();
console.log('Atlas sampling: every water-chart texel centre, including top/left edges and corners, excludes surrounding sand.');
