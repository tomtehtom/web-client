import * as THREE from 'three';
import { BLOCKS, initBlockData, getMinecraftBrightnessBias, getSharedAtlasTexture, getBlockMatchingMode, getBlockPaletteKey } from './assignToBlocksForGLB.js';

export class VoxelExportSession {
  async run(grid, format, onProgress) {
    const generation = this.generation ?? 0;
    if (this.pending) throw new Error('An export is already running');
    await initBlockData();
    if (generation !== (this.generation ?? 0)) throw new Error('Export cancelled');
    if (this.pending) throw new Error('An export is already running');
    if (!this.worker) this.worker = new Worker(new URL('./voxel-export.worker.js', import.meta.url), { type: 'module' });
    const paletteKey = JSON.stringify([getMinecraftBrightnessBias(), getBlockPaletteKey(), BLOCKS.map(b => b.name)]);
    const payload = { format, maxCells: matchMedia('(pointer: coarse)').matches ? 16_000_000 : 50_000_000 };
    if (this.grid !== grid) payload.grid = grid;
    if (this.paletteKey !== paletteKey) {
      payload.palette = BLOCKS.map(({ name, oklab, uv, faceUvs }) => ({ name, oklab, uv, faceUvs }));
      payload.bias = getMinecraftBrightnessBias();
      payload.matchingMode = getBlockMatchingMode();
    }
    return new Promise((resolve, reject) => {
      this.pending = reject;
      this.worker.onmessage = ({ data }) => {
        if (data.status === 'progress') { onProgress?.(data.message); return; }
        this.pending = null;
        if (data.status === 'error') { reject(new Error(data.message)); return; }
        this.grid = grid; this.paletteKey = paletteKey;
        resolve(data.result);
      };
      this.worker.onerror = error => { this.dispose(); reject(new Error(error.message)); };
      // One copy into the export worker, retained for subsequent formats. Preview
      // buffers are never detached, so rendering and repeated exports stay valid.
      try { this.worker.postMessage(payload); }
      catch (error) { this.pending = null; reject(error); }
    });
  }
  dispose() {
    this.generation = (this.generation ?? 0) + 1;
    this.worker?.terminate(); this.worker = null;
    this.pending?.(new Error('Export cancelled')); this.pending = null;
    this.grid = null; this.paletteKey = null;
  }
}

export async function makeExportGroup(surface) {
  const group = new THREE.Group(), materials = [];
  if (surface.palette) {
    const atlas = await getSharedAtlasTexture();
    const byName = new Map(BLOCKS.map(block => [block.name, block]));
    for (let index = 0; index < surface.palette.length; index++) {
      const block = byName.get(surface.palette[index]);
      const rect = block.faceUvs?.[surface.materialFaces?.[index]] ?? block.uv;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
      // The shared preview atlas has flipY=false: its UV rows follow image rows.
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = false;
      context.drawImage(atlas.image, Math.round(rect.offsetX * atlas.image.width),
        Math.round(rect.offsetY * atlas.image.height), Math.round(rect.repeatX * atlas.image.width),
        Math.round(rect.repeatY * atlas.image.height), 0, 0, 16, 16);
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.minFilter = texture.magFilter = THREE.NearestFilter; texture.generateMipmaps = false;
      materials.push(new THREE.MeshBasicMaterial({ map: texture }));
    }
  } else materials.push(new THREE.MeshBasicMaterial({ vertexColors: true }));
  let deadline = performance.now() + 4;
  for (const data of surface.geometries) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    if (data.colors8) geometry.setAttribute('color', new THREE.BufferAttribute(data.colors8, 4, true));
    if (data.uv) geometry.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2));
    for (const g of data.groups ?? []) geometry.addGroup(g.start, g.count, g.materialIndex);
    group.add(new THREE.Mesh(geometry, surface.palette ? materials : materials[0]));
    if (performance.now() > deadline) { await new Promise(resolve => setTimeout(resolve, 0)); deadline = performance.now() + 4; }
  }
  group.userData.disposeExport = () => {
    group.traverse(node => node.geometry?.dispose());
    for (const material of materials) { material.map?.dispose(); material.dispose(); }
  };
  return group;
}

export function downloadExport(data, filename) {
  const url = URL.createObjectURL(new Blob(data.fileParts ?? data.archiveParts ?? [data], { type: data.archiveParts ? 'application/zip' : 'application/octet-stream' }));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
