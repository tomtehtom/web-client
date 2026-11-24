import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';

let server,browser;
try {
  server=await createServer({server:{host:'127.0.0.1',port:0,open:false}});await server.listen();
  browser=await chromium.launch({headless:true,channel:process.env.VOXEL_BROWSER||'msedge',
    args:process.env.VOXEL_SOFTWARE_GL?['--use-angle=swiftshader','--enable-unsafe-swiftshader']:[]});
  const page=await browser.newPage();
  await page.route('**/__sampler-test',route=>route.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
  await page.goto(new URL('/__sampler-test',server.resolvedUrls.local[0]).href);
  const result=await page.evaluate(async()=>{
    const THREE=await import('/node_modules/.vite/deps/three.js');
    const {createVoxelTextureSampler}=await import('/src/voxel-texture-sampler.js');
    const renderer=new THREE.WebGLRenderer({antialias:false});renderer.setSize(1,1);
    const target=new THREE.WebGLRenderTarget(1,1);target.texture.colorSpace=THREE.LinearSRGBColorSpace;
    const material=new THREE.ShaderMaterial({uniforms:{image:{value:null},query:{value:new THREE.Vector2()},uvMatrix:{value:new THREE.Matrix3()}},
      vertexShader:'void main(){gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader:'uniform sampler2D image;uniform vec2 query;uniform mat3 uvMatrix;void main(){gl_FragColor=texture2D(image,(uvMatrix*vec3(query,1.0)).xy);}',toneMapped:false});
    const scene=new THREE.Scene(),geometry=new THREE.PlaneGeometry(2,2);scene.add(new THREE.Mesh(geometry,material));
    const camera=new THREE.Camera(),bytes=new Uint8Array(4),data=new Uint8ClampedArray(16*16*4);
    for(let y=0;y<16;y++)for(let x=0;x<16;x++)data.set(x>=12&&y>=12?[40,100,100,255]:[218,190,150,255],(x+y*16)*4);
    const canvas=document.createElement('canvas');canvas.width=canvas.height=16;canvas.getContext('2d').putImageData(new ImageData(data,16,16),0,0);
    let tested=0,maxError=0;const failures=[];
    for(const srgb of [false,true])for(const flipY of [false,true])for(const wrap of [THREE.ClampToEdgeWrapping,THREE.RepeatWrapping,THREE.MirroredRepeatWrapping])for(const rotation of [0,.4]) {
      const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=srgb?THREE.SRGBColorSpace:THREE.NoColorSpace;
      texture.flipY=flipY;texture.minFilter=texture.magFilter=THREE.LinearFilter;texture.generateMipmaps=false;
      texture.wrapS=texture.wrapT=wrap;texture.rotation=rotation;
      texture.repeat.set(1.3,.7);texture.offset.set(.1,-.2);texture.center.set(.5,.5);texture.updateMatrix();
      material.uniforms.image.value=texture;material.uniforms.uvMatrix.value.copy(texture.matrix);
      const sample=createVoxelTextureSampler({data,width:16,height:16},texture,srgb);
      for(const uv of [[12.5/16,12.5/16],[12.5/16,14.5/16],[14.5/16,12.5/16],[.01,.99],[0,0],[1,1],[-.2,1.2],[.39,.71]]) {
        material.uniforms.query.value.set(...uv);renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,1,1,bytes);
        const expected=sample({x:uv[0],y:uv[1]}).map(v=>Math.round(v*255));
        const error=Math.max(...expected.map((v,c)=>Math.abs(v-bytes[c])));maxError=Math.max(maxError,error);tested++;
        if(error>3)failures.push({srgb,flipY,wrap,rotation,uv,expected,actual:[...bytes],error});
      }
      texture.dispose();
    }
    renderer.setRenderTarget(null);geometry.dispose();material.dispose();target.dispose();renderer.dispose();
    return {tested,maxError,failures:failures.slice(0,8)};
  });
  assert.deepEqual(result.failures,[],JSON.stringify(result));
  console.log(`Texture GPU oracle: ${result.tested} opaque samples match WebGL within ${result.maxError}/255 across UV transforms, colour spaces, flipY and wrapping modes.`);
}finally{await browser?.close();await server?.close();}
