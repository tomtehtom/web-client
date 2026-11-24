import * as T from 'three';
import {PLYLoader} from 'three/addons/loaders/PLYLoader.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {readFile,writeFile,access} from 'node:fs/promises';
globalThis.FileReader=class {readAsArrayBuffer(blob){blob.arrayBuffer().then(v=>{this.result=v;this.onloadend?.();});}readAsDataURL(blob){blob.arrayBuffer().then(v=>{this.result=`data:${blob.type};base64,${Buffer.from(v).toString('base64')}`;this.onloadend?.();});}};
const native=process.argv.includes('--native');
const geometryOnly=process.argv.includes('--geometry');
const base=new URL(native?'../../assets/west-pier/photogrammetry/run-native-quality/dense/':'../../assets/west-pier/photogrammetry/run-retry-1600/dense-2/',import.meta.url);
let filename=native?(geometryOnly?'mesh-all-geometry.ply':'mesh-colour-only.ply'):'mesh.ply';let allowColour=!geometryOnly;
if(native){try{await access(new URL(filename,base));}catch{filename='mesh-all-geometry.ply';allowColour=false;}}
const raw=await readFile(new URL(filename,base));const geometry=new PLYLoader().parse(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength));geometry.computeVertexNormals();geometry.computeBoundingBox();
if(!geometry.getAttribute('position')?.count)throw Error('Empty COLMAP mesh');
const mesh=new T.Mesh(geometry,new T.MeshStandardMaterial({vertexColors:allowColour&&!!geometry.getAttribute('color'),color:allowColour?0xffffff:0xb0b0b0,roughness:1,side:T.DoubleSide}));mesh.name='COLMAP unscaled incomplete reconstruction';mesh.userData={scale:'arbitrary; not metres',historicalTarget:'mixed pre-fire reference dates',status:'experimental partial mesh; not a finished Minecraft asset',colourPolicy:allowColour?'source colour observations':'neutral material; mixed monochrome geometry source'};
const scene=new T.Scene();scene.add(mesh);const result=await new GLTFExporter().parseAsync(scene,{binary:true});await writeFile(new URL(native?(geometryOnly?'west-pier-native-geometry-unscaled.glb':'west-pier-native-partial-unscaled.glb'):'west-pier-colmap-partial-unscaled.glb',base),Buffer.from(result));
console.log(JSON.stringify({vertices:geometry.getAttribute('position').count,triangles:geometry.index?geometry.index.count/3:geometry.getAttribute('position').count/3,coloured:allowColour&&!!geometry.getAttribute('color'),bounds:geometry.boundingBox,bytes:result.byteLength}));
