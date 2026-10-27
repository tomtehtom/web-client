import assert from 'node:assert/strict';
import * as THREE from 'three';
import { serializeModel } from '../src/voxelize-model.js';
import { WorkerVoxelizer } from '../src/voxelizer.worker.js';

// Owned smooth texture: changes to triangle size or its diagonal must not turn
// UV interpolation into one sampled colour per triangle.
const previousImageData = globalThis.ImageData;
globalThis.ImageData ??= class {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
async function voxelize(scale, alternateDiagonal = false, constant = false, method = '2.5d-scan') {
  const size = 32, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    pixels.set([constant ? 170 : Math.round(x / (size - 1) * 255), constant ? 140 : Math.round(y / (size - 1) * 255), 110, 255], (x + size * y) * 4);
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.colorSpace = THREE.SRGBColorSpace;
  const geometry = new THREE.PlaneGeometry(8, 8);
  if (alternateDiagonal) geometry.setIndex([0, 2, 3, 0, 3, 1]);
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const model = new THREE.Mesh(geometry, material); model.scale.setScalar(scale);
  const result = await new WorkerVoxelizer().init({ modelData: serializeModel(model), voxelSize: .5 * scale, method, renderMode: 'packed', needGrid: true });
  const sparse = result.voxelGrid.sparse;
  const colours = new Map(Array.from(sparse.indices, (index, i) => [index, sparse.colors[i]]));
  texture.dispose(); geometry.dispose(); material.dispose();
  return colours;
}
try {
  for (const method of ['2.5d-scan']) {
    const reference = await voxelize(1, false, false, method);
    assert.equal(reference.size, 256);
    assert.equal(new Set(reference.values()).size, 256);
    for (const scale of [1e-2, 1e-4, 1e-6]) for (const diagonal of [false, true]) {
      const actual = await voxelize(scale, diagonal, false, method);
      assert.equal(actual.size, reference.size);
      for (const [index, expected] of reference) {
        assert.ok(actual.has(index));
        for (const shift of [0, 8, 16]) assert.ok(Math.abs(((actual.get(index) >>> shift) & 255) - ((expected >>> shift) & 255)) <= 1,
          `${method}: UV colour changed with normalization scale ${scale}, diagonal ${diagonal}, voxel ${index}`);
      }
    }
    const constant = await voxelize(1e-4, true, true, method);
    assert.equal(new Set(constant.values()).size, 1, 'Uniform source colour must stay uniform across triangles');
  }
  console.log('Triangle colours: smooth gradients preserved across scene scales 1 to 0.000001 and both triangulations in the default Scan voxelizer; constant colours remain uniform.');
} finally {
  if (previousImageData === undefined) delete globalThis.ImageData;
  else globalThis.ImageData = previousImageData;
}
