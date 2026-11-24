import * as THREE from 'three';

const R = 6378137, E2 = 6.6943799901413165e-3, RAD = Math.PI / 180;
const STEP = 250 / R;
const wrap = radians => ((radians + Math.PI) % (2*Math.PI) + 2*Math.PI) % (2*Math.PI) - Math.PI;

export function ecefPosition(latitude, longitude, height) {
  const lat=latitude*RAD,lon=longitude*RAD,n=R/Math.sqrt(1-E2*Math.sin(lat)**2);
  return new THREE.Vector3((n+height)*Math.cos(lat)*Math.cos(lon),(n+height)*Math.cos(lat)*Math.sin(lon),
    (n*(1-E2)+height)*Math.sin(lat));
}

export function resolveCaptureFrame(rawCenter,latitude,longitude,radius=500) {
  const expected=ecefPosition(latitude,longitude,0),raw=new THREE.Vector3().fromArray(rawCenter);
  const candidates=[['ECEF Z-up',new THREE.Matrix4()],['glTF Y-up',new THREE.Matrix4().makeRotationX(Math.PI/2)],
    ['inverse Y-up',new THREE.Matrix4().makeRotationX(-Math.PI/2)],['glTF X-up',new THREE.Matrix4().makeRotationY(-Math.PI/2)]];
  let best;
  for(const [name,correction] of candidates) {
    const center=raw.clone().applyMatrix4(correction),distance=center.distanceTo(expected);
    if(!best||distance<best.distance)best={name,correction,center,distance};
  }
  if(!best || !Number.isFinite(best.distance) || best.distance>Math.max(100000,radius*20))return null;
  const up=best.center.clone().normalize(),east=new THREE.Vector3(-best.center.y,best.center.x,0).normalize();
  if(east.lengthSq()===0)east.set(0,1,0);
  const south=new THREE.Vector3().crossVectors(up,east).negate();
  const frame=new THREE.Matrix4().set(east.x,east.y,east.z,0,up.x,up.y,up.z,0,south.x,south.y,south.z,0,0,0,0,1);
  return {...best,frame,sourceToView:frame.clone().multiply(best.correction)};
}

// Fixed latitude rows and fixed longitude columns per row. Capture coordinates
// only select members of this worldwide set; they never move its origin.
// Row-dependent columns keep spacing approximately 250 ground metres globally.
export function geographicMarkerPoints(latitude, longitude, radius, height=200) {
  if (![latitude,longitude,radius,height].every(Number.isFinite) || Math.abs(latitude)>90 || radius<0 || radius>20000) {
    throw new Error('Invalid geographic marker capture bounds');
  }
  const lat=latitude*RAD,lon=wrap(longitude*RAD),angular=radius/R,points=[];
  const first=Math.ceil(Math.max(-Math.PI/2,lat-angular)/STEP-1e-10);
  const last=Math.floor(Math.min(Math.PI/2,lat+angular)/STEP+1e-10);
  for(let row=first;row<=last;row++) {
    const phi=row*STEP,columns=Math.max(1,Math.round(2*Math.PI*R*Math.cos(phi)/250));
    const delta=2*Math.PI/columns;
    const span=Math.min(Math.PI,angular/Math.max(1e-9,Math.cos(phi-angular)));
    const seen=new Set();
    for(let col=Math.ceil((lon-span)/delta)-1;col<=Math.floor((lon+span)/delta)+1;col++) {
      const canonical=((col%columns)+columns)%columns;
      if(seen.has(canonical))continue;seen.add(canonical);
      const lambda=wrap(canonical*delta);
      const hav=Math.sin((phi-lat)/2)**2+Math.cos(lat)*Math.cos(phi)*Math.sin(wrap(lambda-lon)/2)**2;
      const distance=2*R*Math.asin(Math.min(1,Math.sqrt(hav)));
      if(distance<=radius+1e-6)points.push({id:`geo250:${row}:${canonical}`,latitude:phi/RAD,longitude:lambda/RAD,height});
    }
  }
  return points;
}

export function planGeographicMarkers(viewer, rotationDegrees, metresPerBlock, depthBlocks=25, sourceBounds=null) {
  const {latitude,longitude,radiusMeters}=viewer.captureMetadata??{};
  if(!viewer.ecefCenter || !viewer.ecefFrame || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('Fetch geographic source tiles before enabling alignment markers.');
  }
  const frame=new THREE.Matrix4().fromArray(viewer.ecefFrame),center=new THREE.Vector3().fromArray(viewer.ecefCenter);
  if(center.length()<6000000 || center.length()>7000000)throw new Error('Loaded scene is not in the expected Earth coordinate frame. Fetch geographic tiles again.');
  const rotation=new THREE.Matrix4().makeRotationY(rotationDegrees*RAD);
  const origin=viewer.rotationCenter??new THREE.Vector3();
  if(!sourceBounds || !Number.isInteger(depthBlocks) || depthBlocks<0 || depthBlocks>1000)throw new Error('Marker depth must be a whole number between 0 and 1,000 blocks.');
  if(!Number.isFinite(viewer.metersPerViewerUnit)||viewer.metersPerViewerUnit<=0||!viewer.ecefCenter.every(Number.isFinite)||!viewer.ecefFrame.every(Number.isFinite))throw new Error('Invalid capture coordinate frame. Fetch the source tiles again.');
  const blockSize=metresPerBlock/viewer.metersPerViewerUnit;
  const markerY=(Math.floor(sourceBounds.min.y/blockSize+1e-7)-depthBlocks)*blockSize;
  return geographicMarkerPoints(latitude,longitude,radiusMeters,0).map(point=>{
    const p=ecefPosition(point.latitude,point.longitude,point.height);
    if(p.distanceTo(center)>Math.max(100000,radiusMeters*20))throw new Error('Capture latitude/longitude does not match the loaded Earth geometry. Fetch tiles at the requested location again.');
    p.sub(center).applyMatrix4(frame).divideScalar(viewer.metersPerViewerUnit);
    // The request circle defines marker membership. Decoded model bounds may
    // be offset, partial or contain gaps and must not veto geographic points.
    p.y=markerY;
    p.sub(origin).applyMatrix4(rotation).add(origin);
    if(!p.toArray().every(Number.isFinite))throw new Error('Invalid geographic marker position. Fetch the source tiles again.');
    const reach=sourceBounds.getCenter(new THREE.Vector3()).distanceTo(p)*viewer.metersPerViewerUnit;
    if(reach>Math.max(100000,radiusMeters*20))throw new Error(`Marker coordinates do not match the loaded scene (${Math.round(reach)} m away). Fetch tiles at the requested location again.`);
    return {...point,height:null,depthBlocks,position:p.toArray(),size:blockSize};
  });
}

export function markerVoxelizationSource(source,plans,rotationDegrees,rotationCenter,blockSize) {
  const root=new THREE.Group();
  const rotation=new THREE.Matrix4().makeTranslation(...rotationCenter.toArray())
    .multiply(new THREE.Matrix4().makeRotationY(rotationDegrees*RAD))
    .multiply(new THREE.Matrix4().makeTranslation(...rotationCenter.clone().negate().toArray()));
  source.applyMatrix4(rotation);root.add(source);
  // Inward sampling surface avoids both SAT boundary contacts and Scan's 15%
  // secondary-slice margin. Both 1x and 2x sampling still fill the full block.
  const geometry=new THREE.BoxGeometry(blockSize*.68,blockSize*.68,blockSize*.68);
  const material=new THREE.MeshBasicMaterial({color:0xff0000});
  for(const point of plans) {
    const cube=new THREE.Mesh(geometry,material);
    cube.position.fromArray(point.position.map(v=>(Math.floor(v/blockSize+1e-7)+.5)*blockSize));
    cube.name=`marker:${point.id}`;root.add(cube);
  }
  root.userData.voxelGridBlockSize=blockSize;
  root.userData.disposeMarkerSource=()=>{geometry.dispose();material.dispose();};
  root.updateMatrixWorld(true);
  return root;
}

export function attachGeographicMarkers(grid, plans, sampling=1) {
  const min=Array.isArray(grid.bbox.min)?grid.bbox.min:[grid.bbox.min.x,grid.bbox.min.y,grid.bbox.min.z];
  const size=grid.unit.x*sampling;
  grid.editorMarkers=plans.map(point=>({...point,x:Math.floor((point.position[0]-min[0])/size+1e-7),
    y:Math.floor((point.position[1]-min[1])/size+1e-7),z:Math.floor((point.position[2]-min[2])/size+1e-7)}));
  grid.exportMetadata.geographicMarkers={version:1,grid:'geo250',spacingMetres:250,spacing:'approximate ground distance',
    heightDatum:plans[0]?.depthBlocks!=null?'scan minimum':'WGS84 ellipsoid',height:plans[0]?.height??null,depthBlocks:plans[0]?.depthBlocks??null,block:'minecraft:red_concrete',
    markers:grid.editorMarkers.map(({id,latitude,longitude,height,x,y,z})=>({id,latitude,longitude,height,x,y,z}))};
}

export function markerPreview(grid) {
  const markers=grid.editorMarkers??[],factor=grid.exportMetadata.shapeSampling===2?2:1,size=grid.unit.x*factor;
  const min=Array.isArray(grid.bbox.min)?grid.bbox.min:[grid.bbox.min.x,grid.bbox.min.y,grid.bbox.min.z];
  const mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(size,size,size),new THREE.MeshBasicMaterial({color:0xff0000}),markers.length);
  const matrix=new THREE.Matrix4();
  markers.forEach((p,i)=>mesh.setMatrixAt(i,matrix.makeTranslation(min[0]+(p.x+.5)*size,min[1]+(p.y+.5)*size,min[2]+(p.z+.5)*size)));
  mesh.computeBoundingBox();mesh.computeBoundingSphere();mesh.name='geographicAlignmentMarkers';
  return mesh;
}
