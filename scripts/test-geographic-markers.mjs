import assert from 'node:assert/strict';
import { geographicMarkerPoints, ecefPosition, attachGeographicMarkers, planGeographicMarkers, markerVoxelizationSource, resolveCaptureFrame } from '../src/geographic-markers.js';
import { WorkerVoxelizer } from '../src/voxelizer.worker.js';
import { serializeModel } from '../src/voxelize-model.js';
import { iterateVoxelSamples, setExportBlockPalette } from '../src/assignToBlocksForGLB.js';
import { buildSparseSchematic, writeCombinedSchematic } from '../src/combined-schematic.js';
import { fitHalfBlockGrid } from '../src/shape-fitting.js';
import { exportTiledSchematics } from '../src/tiled-export.js';
import * as THREE from 'three';
import nbt from 'prismarine-nbt';
const a=geographicMarkerPoints(50.82,-.14,1500,200),b=geographicMarkerPoints(50.821,-.139,1600,200);
const shared=new Map(b.map(p=>[p.id,p]));
let matches=0;
for(const marker of a) if(shared.has(marker.id)){assert.deepEqual(marker,shared.get(marker.id));matches++;}
assert.ok(matches>50,'Overlapping requests must select identical geographic positions');
for(const lon of [179.999,-179.999]) {
  const points=geographicMarkerPoints(0,lon,1000);
  assert.ok(points.some(p=>p.longitude>179));assert.ok(points.some(p=>p.longitude< -179));
  assert.equal(new Set(points.map(p=>p.id)).size,points.length);
}
assert.ok(geographicMarkerPoints(89.999,0,500).length>0);
assert.deepEqual(ecefPosition(0,0,0).toArray(),[6378137,0,0]);
for(const [name,correction] of [['ECEF Z-up',new THREE.Matrix4()],['glTF Y-up',new THREE.Matrix4().makeRotationX(Math.PI/2)],
  ['inverse Y-up',new THREE.Matrix4().makeRotationX(-Math.PI/2)],['glTF X-up',new THREE.Matrix4().makeRotationY(-Math.PI/2)]]) {
  const earth=ecefPosition(50.82,-.14,30),raw=earth.clone().applyMatrix4(correction.clone().invert());
  const resolved=resolveCaptureFrame(raw.toArray(),50.82,-.14,750);
  assert.equal(resolved.name,name);assert.ok(resolved.center.distanceTo(earth)<1e-8);
  const point=ecefPosition(50.821,-.139,0);
  const expected=point.clone().sub(earth).applyMatrix4(resolved.frame);
  const actual=point.clone().applyMatrix4(correction.clone().invert()).sub(raw).applyMatrix4(resolved.sourceToView);
  assert.ok(actual.distanceTo(expected)<1e-7,'Geometry and markers must share the corrected Earth frame');
}
assert.equal(resolveCaptureFrame([0,0,0],50.82,-.14,750),null);
const viewer={captureMetadata:{latitude:0,longitude:0,radiusMeters:500},ecefCenter:[6378137,0,0],metersPerViewerUnit:10,
  ecefFrame:new THREE.Matrix4().set(0,1,0,0,1,0,0,0,0,0,-1,0,0,0,0,1).toArray()};
const bounds=new THREE.Box3(new THREE.Vector3(-2,-1.13,-2),new THREE.Vector3(2,1,2));
const underground=planGeographicMarkers(viewer,15,1,25,bounds);
assert.ok(underground.length>0);
assert.ok(underground.every(p=>Math.abs(p.position[1]-(-3.7))<1e-12 && p.depthBlocks===25));
const changed=planGeographicMarkers(viewer,15,1,25,new THREE.Box3(new THREE.Vector3(-2,-2.13,-2),bounds.max));
assert.deepEqual(changed.map(p=>[p.id,p.latitude,p.longitude,p.position[0],p.position[2]]),underground.map(p=>[p.id,p.latitude,p.longitude,p.position[0],p.position[2]]));
assert.ok(changed.every((p,i)=>Math.abs(p.position[1]-underground[i].position[1]+1)<1e-12),'Changed scan minimum must shift only marker height');
for(const [latitude,longitude] of [[50.82,-.14],[51.5074,-.1278],[-33.86,151.2],[0,0]]) {
  const center=ecefPosition(latitude,longitude,0),up=center.clone().normalize();
  const east=new THREE.Vector3(-center.y,center.x,0).normalize(),south=new THREE.Vector3().crossVectors(up,east).negate();
  const frame=new THREE.Matrix4().set(east.x,east.y,east.z,0,up.x,up.y,up.z,0,south.x,south.y,south.z,0,0,0,0,1);
  const capture={captureMetadata:{latitude,longitude,radiusMeters:750},ecefCenter:center.toArray(),ecefFrame:frame.toArray(),metersPerViewerUnit:2000};
  const narrowBounds=new THREE.Box3(new THREE.Vector3(-.0001,-.001,-.0001),new THREE.Vector3(.0001,.001,.0001));
  const points=planGeographicMarkers(capture,15,1,25,narrowBounds),expected=geographicMarkerPoints(latitude,longitude,750,0);
  assert.ok(points.length>=20,`750m capture must contain many grid points at ${latitude},${longitude}`);
  assert.deepEqual(points.map(p=>p.id),expected.map(p=>p.id),'Model footprint must never discard requested geographic markers');
  assert.ok(points.every(p=>p.position.every(Number.isFinite)));
}

setExportBlockPalette([{name:'white_wool',oklab:{L:1,a:0,b:0}}]);
const makeGrid=factor=>({gridSize:{x:260*factor,y:2*factor,z:2*factor},unit:{x:1/factor,y:1/factor,z:1/factor},
  bbox:{min:[0,0,0],max:[260,2,2]},exportMetadata:{shapeSampling:factor,metersPerBlock:1},
  sparse:{indices:new Float64Array([0]),colors:new Uint32Array([0xffffffff])}});
const plans=[{id:'a',latitude:0,longitude:0,height:200,position:[0,0,0]},{id:'b',latitude:0,longitude:1,height:200,position:[250,0,0]}];
for(const factor of [1,2]) {
  const grid=makeGrid(factor);attachGeographicMarkers(grid,plans,factor);
  let raw=[];iterateVoxelSamples(grid,p=>raw.push(p));
  assert.equal(raw.length,2*factor**3,'Markers must replace overlapping source cells without duplicates');
  assert.ok(raw.every(p=>p.state==='red_concrete'));
  const fitted=factor===2?fitHalfBlockGrid(grid,[{name:'stone_slab',colours:{balanced:{r:.5,g:.5,b:.5}},variants:[{mask:51,state:'stone_slab[type=bottom]'}]}]):grid;
  const blocks=buildSparseSchematic(fitted);
  assert.deepEqual(blocks.palette,['minecraft:air','minecraft:red_concrete'],'Marker material must override even a palette without red blocks');
  assert.equal(blocks.positions.length,2);assert.equal(blocks.size.x,251);assert.equal(blocks.size.y,1);
  const parsed=nbt.simplify((await nbt.parse(Buffer.concat((await writeCombinedSchematic(fitted)).fileParts))).parsed);
  assert.equal(parsed.Palette['minecraft:red_concrete'],1);
  assert.equal(JSON.parse(parsed.Metadata.VoxelEarth).geographicMarkers.markers[1].id,'b');
  const tiled=await exportTiledSchematics(fitted);
  assert.equal(tiled.manifest.tiles.length,2,'Marker-only tiles must be included');
  assert.ok(tiled.manifest.tiles.every(tile=>tile.size.x===1&&tile.size.y===1&&tile.size.z===1),'Each tile must contain only its own marker');
}
for(const factor of [1,2]) for(const method of ['3d-sat','2.5d-scan']) {
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial());
  const input=markerVoxelizationSource(mesh,[{id:'real-cube',position:[250,-25,0]}],15,new THREE.Vector3(),1);
  const payload=serializeModel(input,{cache:false});
  assert.equal(payload.meshes.length,2,'Red cube must enter the actual worker source geometry');
  assert.ok(payload.bbox.min.every(Number.isInteger));
  const output=await new WorkerVoxelizer().init({modelData:payload,voxelSize:1/factor,method,renderMode:'packed',needGrid:true});
  let red=0;
  iterateVoxelSamples(output.voxelGrid,p=>{
    const min=output.voxelGrid.bbox.min;
    const x=min[0]+p.x/factor,y=min[1]+p.y/factor,z=min[2]+p.z/factor;
    if(x>=250&&x<251&&y>=-25&&y< -24&&z>=0&&z<1){red++;assert.ok(p.r>.99&&p.g<.01&&p.b<.01);}
  });
  assert.equal(red,factor**3,'Actual voxelized marker must contain one full-block volume before export overrides');
  input.userData.disposeMarkerSource();mesh.geometry.dispose();mesh.material.dispose();
}
assert.throws(()=>planGeographicMarkers({...viewer,ecefCenter:[0,0,0]},0,1,25,bounds),/Earth coordinate/);
console.log(`Geographic markers: ${matches} common IDs across different scan origins, date line/polar cases, 25-block underground depth, horizontal stability with changed minima, full-block overrides in normal/slab modes, marker-only tiles and bounds passed.`);
