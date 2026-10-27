import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Editable, metric reconstruction study. Unmeasured dimensions are estimates.
const out = fileURLToPath(new URL('../../assets/west-pier/', import.meta.url));
await mkdir(out, {recursive:true});
const palette = {cream:'#e0d8bd', red:'#784138', iron:'#393833', wood:'#8b8170', roof:'#b9b8a8', glass:'#52696b', darkroof:'#625f57'};
const parts = new Map(Object.keys(palette).map(k=>[k,[]]));
function add(g,mat,x=0,y=0,z=0,rot=0){g.rotateY(rot);g.translate(x,y,z); if(g.index)g=g.toNonIndexed(); g.deleteAttribute('uv');parts.get(mat).push(g);}
function box(x,y,z,w,h,d,m='cream'){add(new T.BoxGeometry(w,h,d),m,x,y,z);}
function rod(a,b,r=.13,m='iron',s=6){const av=new T.Vector3(...a),bv=new T.Vector3(...b),v=bv.clone().sub(av);const g=new T.CylinderGeometry(r,r,v.length(),s);g.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0),v.normalize()));g.translate(...av.add(bv).multiplyScalar(.5).toArray());add(g,m);}
function hip(x,z,w,d,y,h,topW=.3,topD=.3,m='roof'){
 const p=[[-w/2,y,-d/2],[w/2,y,-d/2],[w/2,y,d/2],[-w/2,y,d/2],[-topW/2,y+h,-topD/2],[topW/2,y+h,-topD/2],[topW/2,y+h,topD/2],[-topW/2,y+h,topD/2]];
 const ids=[0,4,5,0,5,1,1,5,6,1,6,2,2,6,7,2,7,3,3,7,4,3,4,0];
 const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(ids.flatMap(i=>p[i]),3));g.computeVertexNormals();add(g,m,x,0,z);
}
const deckY=9;
function deck(z0,z1,w){box(0,deckY-.25,(z0+z1)/2,w,.5,z1-z0,'wood');box(0,deckY-.8,(z0+z1)/2,w,.55,z1-z0,'red');
 for(let z=z0+2;z<z1;z+=6){for(let x=-w/2+1;x<w/2;x+=6){rod([x,-3,z],[x,deckY-.7,z],.23);rod([x,-1,z],[x,deckY-1,z+5],.09);}
 box(0,deckY-1,z,w,.28,.28,'iron');}
 for(const x of [-w/2+.2,w/2-.2]){for(let z=z0;z<=z1;z+=2)rod([x,deckY,z],[x,deckY+1.15,z],.07,'cream'); for(const y of [deckY+.35,deckY+1.1])rod([x,y,z0],[x,y,z1],.07,'cream');}
}
// Landward origin. +Z runs seaward; total deck length 1115 ft = 339.852 m.
deck(0,175,13);deck(175,247,35);deck(247,279,19);deck(279,339.852,50);
// Repeating promenade furniture and lamps.
for(let z=10;z<334;z+=12){const w=z<175?13:z<247?35:z<279?19:50;for(const s of [-1,1]){const x=s*(w/2-.7);rod([x,9,z],[x,12.3,z],.1,'cream');add(new T.SphereGeometry(.3,8,6),'cream',x,12.45,z);if(z<175){box(s*4.7,9.5,z+3,1.5,.15,.65,'wood');box(s*5.3,9.9,z+3,.15,.8,.65,'cream');}}}
function windows(x,z,w,d,y,h){
 for(const s of [-1,1]){for(let zz=z-d/2+1.5;zz<z+d/2;zz+=2.8){box(x+s*(w/2+.03),y,zz,.12,h,1.75,'glass');box(x+s*(w/2+.14),y,zz,.12,h,.09);box(x+s*(w/2+.14),y,zz,.12,.1,1.8);}}
 for(const s of [-1,1])for(let xx=x-w/2+1.5;xx<x+w/2;xx+=2.8){box(xx,y,z+s*(d/2+.03),1.75,h,.12,'glass');box(xx,y,z+s*(d/2+.14),.09,h,.12);}
}
function hall(z,w,d){box(0,12,z,w,6,d,'red'); windows(0,z,w,d,12.3,3.5); for(const y of [9.4,10.1,14.6,15.2])box(0,y,z,w+.35,.22,d+.35);
 for(const s of [-1,1])for(let zz=z-d/2;zz<=z+d/2;zz+=2.8)box(s*(w/2+.16),12,zz,.3,6.2,.3);
}
// Concert hall: broad curved roof with a raised clerestory and ornamental crest.
hall(211,25,43);
const roofShape=new T.Shape();roofShape.moveTo(-13.5,0);for(let i=0;i<=24;i++){const a=Math.PI-i*Math.PI/24;roofShape.lineTo(13.5*Math.cos(a),6.5*Math.sin(a));}roofShape.lineTo(13.5,-.25);roofShape.lineTo(-13.5,-.25);
const curved=new T.ExtrudeGeometry(roofShape,{depth:45,bevelEnabled:false,steps:1});add(curved,'cream',0,15,188.5);
box(0,21.3,211,5,1.9,28,'red');windows(0,211,5,28,21.4,1.1);hip(0,211,6.5,30,22.3,1.4,4,27,'darkroof');
for(const z of [190,232]){box(0,16,z,25,.4,.4);rod([-12,15.4,z],[0,21.5,z],.18,'cream');rod([0,21.5,z],[12,15.4,z],.18,'cream');}
// Seaward pavilion: wide lower hall, hipped roof, upper glazed lantern.
hall(307,33,39);hip(0,307,36,42,15.2,5.5,18,24,'darkroof');
box(0,21.2,307,18,2.3,24,'red');windows(0,307,18,24,21.3,1.5);box(0,22.5,307,19,.3,25);hip(0,307,20,26,22.65,2.3,13,19,'roof');
function kiosk(x,z,r=3,y=9){add(new T.CylinderGeometry(r,r,3.6,8), 'red',x,y+1.8,z,Math.PI/8);add(new T.CylinderGeometry(r+.15,r+.15,.25,8),'cream',x,y+3.6,z,Math.PI/8);add(new T.CylinderGeometry(.45,r+1,2.6,8),'darkroof',x,y+5,z,Math.PI/8);rod([x,y+6.3,z],[x,y+7.8,z],.08,'cream'); for(let i=0;i<8;i++){const a=i*Math.PI/4+Math.PI/8;rod([x+r*Math.cos(a),y,z+r*Math.sin(a)],[x+r*Math.cos(a),y+3.6,z+r*Math.sin(a)],.1,'cream');}}
for(const x of [-20,20])for(const z of [285,333])kiosk(x,z,2.7);
for(const x of [-8,8])kiosk(x,260,2.5);
// Pavilion corner cupolas visible above the main roof.
for(const x of [-15,15])for(const z of [289,325])kiosk(x,z,1.5,15);
// Entrance toll houses and adjoining wind screens.
for(const x of [-5,5]){box(x,10.5,5,3,3,5,'red');windows(x,5,3,5,10.7,1.4);hip(x,5,4,6,12,1.8,.5,2,'darkroof');}
for(const s of [-1,1])for(let z=14;z<174;z+=3){box(s*6,10.4,z,.14,2.8,.14);box(s*6,10.5,z+1.5,.1,2.1,2.75,'glass');box(s*6,11.7,z+1.5,.2,.18,3);}
// Landing stage on east side, with descending stairs.
box(27,4.2,316,5,.45,40,'wood');for(let z=298;z<=334;z+=6)for(const x of [25,29])rod([x,-3,z],[x,4.2,z],.22);
for(let i=0;i<16;i++)box(24,9-i*.3,292+i*.5,2,.3,.7,'wood');

// Merge by material to keep importer draw calls small. No external textures.
const chunks=[],views=[],accessors=[],meshes=[],nodes=[],materials=[];let offset=0,triangles=0;
function buf(array,target){const b=Buffer.from(array.buffer,array.byteOffset,array.byteLength);const idx=views.length;views.push({buffer:0,byteOffset:offset,byteLength:b.length,target});chunks.push(b);offset+=b.length;const pad=(4-offset%4)%4;if(pad){chunks.push(Buffer.alloc(pad));offset+=pad;}return idx;}
for(const [name,gs] of parts){const g=mergeGeometries(gs);g.computeVertexNormals();const pos=g.getAttribute('position').array,norm=g.getAttribute('normal').array;const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(let i=0;i<pos.length;i++){const j=i%3;min[j]=Math.min(min[j],pos[i]);max[j]=Math.max(max[j],pos[i]);if(!Number.isFinite(pos[i]))throw Error('Nonfinite geometry');}triangles+=pos.length/9;
 const pi=accessors.length;accessors.push({bufferView:buf(pos,34962),componentType:5126,count:pos.length/3,type:'VEC3',min,max});const ni=accessors.length;accessors.push({bufferView:buf(norm,34962),componentType:5126,count:norm.length/3,type:'VEC3'});
 const c=new T.Color(palette[name]);const mi=materials.length;materials.push({name,pbrMetallicRoughness:{baseColorFactor:[c.r,c.g,c.b,1],metallicFactor:0,roughnessFactor:.9},doubleSided:true});nodes.push({name,mesh:meshes.length});meshes.push({name,primitives:[{attributes:{POSITION:pi,NORMAL:ni},material:mi}]});}
const doc={asset:{version:'2.0',generator:'West Pier reconstruction study',extras:{target:'circa 1974-1975',units:'metres',accuracy:'Approximate reconstruction; unverified dimensions and palette. See README.'}},scene:0,scenes:[{nodes:nodes.map((_,i)=>i)}],nodes,meshes,materials,accessors,bufferViews:views,buffers:[{byteLength:offset}]};
const j=Buffer.from(JSON.stringify(doc));const jp=Buffer.concat([j,Buffer.alloc((4-j.length%4)%4,32)]);const bin=Buffer.concat(chunks);const header=Buffer.alloc(12);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(12+8+jp.length+8+bin.length,8);const jh=Buffer.alloc(8);jh.writeUInt32LE(jp.length);jh.writeUInt32LE(0x4e4f534a,4);const bh=Buffer.alloc(8);bh.writeUInt32LE(bin.length);bh.writeUInt32LE(0x004e4942,4);
await writeFile(out+'west-pier-1975-study.glb',Buffer.concat([header,jh,jp,bh,bin]));
await writeFile(out+'model-info.json',JSON.stringify({triangles,materials:materials.length,deckLengthMetres:339.852,target:'1974-1975',status:'approximate study, not measured reconstruction'},null,2));
console.log(JSON.stringify({output:out+'west-pier-1975-study.glb',triangles,materials:materials.length,bytes:header.readUInt32LE(8)}));
