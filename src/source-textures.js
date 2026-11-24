import { ClampToEdgeWrapping } from 'three';

// Photogrammetry atlases often inherit glTF's repeat default even though each
// mesh uses one image. Closest-point sampling at UV=1 must read that edge,
// rather than jumping to UV=0 on the opposite side of the tile image.
export function clampSourceAtlasEdges(root) {
  const eligible=new Map();
  root.traverse(node=>{
    if(!node.isMesh)return;
    const uv=node.geometry?.attributes?.uv;
    let unit=null;
    for(const material of [node.material].flat()) if(material) for(const key of ['map','emissiveMap','alphaMap']) {
      const texture=material[key];if(!texture?.isTexture)continue;
      if(eligible.get(texture)===false)continue;
      const plain=(texture.channel??0)===0&&texture.rotation===0&&texture.repeat.x===1&&texture.repeat.y===1&&texture.offset.x===0&&texture.offset.y===0&&texture.matrixAutoUpdate!==false;
      if(!uv||!plain){eligible.set(texture,false);continue;}
      if(unit===null) {
        unit=true;
        for(let i=0;i<uv.count;i++) {
          const u=uv.getX(i),v=uv.getY(i);
          if(!Number.isFinite(u)||!Number.isFinite(v)||u< -1e-6||u>1+1e-6||v< -1e-6||v>1+1e-6){unit=false;break;}
        }
      }
      eligible.set(texture,unit);
    }
  });
  let changed=0;
  for(const [texture,unit]of eligible)if(unit&&(texture.wrapS!==ClampToEdgeWrapping||texture.wrapT!==ClampToEdgeWrapping)) {
    texture.wrapS=texture.wrapT=ClampToEdgeWrapping;texture.needsUpdate=true;changed++;
  }
  return changed;
}

// Limit decoded source images before thousands of models accumulate. Geometry,
// coverage and metric voxel spacing are unaffected; texture colour detail changes.
export async function limitSourceTextures(root, maxSize, images = new WeakMap()) {
  if (!maxSize) return;
  const textures = new Set();
  root.traverse(node => {
    for (const material of [node.material].flat()) if (material) {
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  let deadline = performance.now() + 8;
  for (const texture of textures) {
    const image = texture.image;
    if (!image || texture.isCompressedTexture || image.data || Math.max(image.width, image.height) <= maxSize) continue;
    let reduced = images.get(image);
    if (!reduced) {
      const ratio = maxSize / Math.max(image.width, image.height);
      reduced = document.createElement('canvas');
      reduced.width = Math.max(1, Math.round(image.width * ratio));
      reduced.height = Math.max(1, Math.round(image.height * ratio));
      const context = reduced.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, reduced.width, reduced.height);
      images.set(image, reduced);
    }
    texture.image = reduced;
    texture.needsUpdate = true;
    if (performance.now() >= deadline) {
      await new Promise(resolve => setTimeout(resolve, 0)); deadline = performance.now() + 8;
    }
  }
}
