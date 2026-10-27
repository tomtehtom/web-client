import {createServer} from 'vite';
import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';
const colmap=process.argv.includes('--colmap');
const base=new URL(colmap?'../../assets/west-pier/photogrammetry/run-retry-1600/dense-2/':'../../assets/west-pier/',import.meta.url);
const server=await createServer({server:{host:'127.0.0.1',port:0,open:false}});await server.listen();
let browser;
try{
 browser=await chromium.launch({headless:true,channel:'msedge',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1600,height:1000}});
 await page.route('**/pier-preview.html',r=>r.fulfill({contentType:'text/html',body:'<html><body style="margin:0"></body></html>'}));
 await page.route('**/pier.glb',async r=>r.fulfill({contentType:'model/gltf-binary',body:await readFile(new URL(colmap?'west-pier-colmap-partial-unscaled.glb':'west-pier-1975-study.glb',base))}));
 await page.goto(server.resolvedUrls.local[0]+'pier-preview.html');
 const info=await page.evaluate(async(colmap)=>{
 const T=await import('/node_modules/three/build/three.module.js');const {GLTFLoader}=await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
 const gltf=await new GLTFLoader().loadAsync('/pier.glb');const scene=new T.Scene();scene.background=new T.Color('#cbd7dc');scene.add(gltf.scene);scene.add(new T.HemisphereLight(0xffffff,0x6e6351,2.5));const sun=new T.DirectionalLight(0xffffff,3);sun.position.set(-100,200,100);scene.add(sun);
 const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(1600,1000);renderer.setPixelRatio(1);document.body.append(renderer.domElement);
 const camera=new T.PerspectiveCamera(35,1.6,.1,2000);camera.position.set(260,200,-110);camera.lookAt(0,9,185);renderer.render(scene,camera);
 window.pier={T,scene,camera,renderer};const b=new T.Box3().setFromObject(gltf.scene);
 if(colmap){const c=b.getCenter(new T.Vector3()),r=b.getSize(new T.Vector3()).length();camera.position.copy(c).add(new T.Vector3(r*2,r,r*.7));camera.lookAt(c);camera.near=r/1000;camera.updateProjectionMatrix();renderer.render(scene,camera);}
 return {min:b.min.toArray(),max:b.max.toArray(),meshes:gltf.scene.children.length};
 },colmap);
 await page.screenshot({path:new URL('preview.png',base).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
 await page.evaluate((colmap)=>{const {T,camera,renderer,scene}=window.pier;if(colmap){const b=new T.Box3().setFromObject(scene.children[0]),c=b.getCenter(new T.Vector3()),r=b.getSize(new T.Vector3()).length();camera.position.copy(c).add(new T.Vector3(-r*2,-r,r*.7));camera.lookAt(c);}else{camera.position.set(-110,75,410);camera.lookAt(0,15,274);}renderer.render(scene,camera);},colmap);
 await page.screenshot({path:new URL('preview-seaward.png',base).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
 console.log(JSON.stringify(info));
}finally{await browser?.close();await server.close();}

