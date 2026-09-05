import assert from 'node:assert/strict';
import { meshVoxelChunks } from '../src/greedy-mesher.js';
import { decodePackedQuad } from '../src/packed-voxel-format.js';
import { makeStore } from './voxel-fixtures.mjs';
import { WorkerVoxelizer } from '../src/voxelizer.worker.js';
import { serializeModel } from '../src/voxelize-model.js';
import * as THREE from 'three';

// An independent unit-face oracle checks geometry, colors, outward winding,
// exact coverage and duplicate faces (including chunk boundaries).
function checkSurface(nx, ny, nz, sample, chunkSize, options = {}) {
  const regular = checkSurfaceMode(nx, ny, nz, sample, chunkSize, options);
  checkSurfaceMode(nx, ny, nz, sample, chunkSize, { ...options, packed: true });
  return regular;
}

function checkSurfaceMode(nx, ny, nz, sample, chunkSize, options = {}) {
  const store = makeStore(nx, ny, nz, sample, chunkSize);
  const result = meshVoxelChunks(store, options);
  const expected = new Set(), actual = new Set();
  const dims = [nx, ny, nz], origin = options.origin ?? [0, 0, 0], scale = options.voxelSize ?? 1;
  const read = (p) => p.some((c, a) => c < 0 || c >= dims[a]) ? 0 : sample(...p) >>> 0;
  const color = (id) => options.paletteColors8
    ? Array.from(options.paletteColors8.slice((id - 1) * 4, (id - 1) * 4 + 3)).join(',')
    : `${id & 255},${(id >>> 8) & 255},${(id >>> 16) & 255}`;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const p = [x, y, z], id = read(p);
    if (!id) continue;
    for (let d = 0; d < 3; d++) for (const sign of [-1, 1]) {
      const q = [...p]; q[d] += sign;
      if (!read(q)) expected.add(`${p}|${d}|${sign}|${color(id)}`);
    }
  }
  for (const g of result.geometries) {
    for (let i = 0; i < g.indices.length; i += 6) {
      const vertices = [0, 1, 2].map(k => Array.from(g.positions.slice(g.indices[i + k] * 3, g.indices[i + k] * 3 + 3)));
      const a = vertices[1].map((v, d) => v - vertices[0][d]), b = vertices[2].map((v, d) => v - vertices[0][d]);
      const normal = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
      const d = normal.findIndex(v => v !== 0), sign = Math.sign(normal[d]);
      assert.ok(d >= 0, 'non-degenerate quad');
      const u = (d + 1) % 3, v = (d + 2) % 3;
      const firstVertex = i / 6 * 4;
      const points = [0, 1, 2, 3].map(k => Array.from(g.positions.slice((firstVertex + k) * 3, (firstVertex + k) * 3 + 3)).map((c, axis) => (c - origin[axis]) / scale));
      const lo = dims.map((_, axis) => Math.min(...points.map(p => p[axis])));
      const hi = dims.map((_, axis) => Math.max(...points.map(p => p[axis])));
      const rgb = Array.from(g.colors8.slice(firstVertex * 4, firstVertex * 4 + 3)).join(',');
      for (let j = lo[v]; j < hi[v]; j++) for (let k = lo[u]; k < hi[u]; k++) {
        const p = [0, 0, 0]; p[d] = lo[d] - (sign > 0 ? 1 : 0); p[u] = k; p[v] = j;
        const key = `${p}|${d}|${sign}|${rgb}`;
        assert.ok(!actual.has(key), `duplicate face ${key}`);
        actual.add(key);
      }
    }
    assert.equal(g.positions.buffer.byteLength, g.positions.byteLength);
    assert.equal(g.colors8.buffer.byteLength, g.colors8.byteLength);
    assert.equal(g.indices.buffer.byteLength, g.indices.byteLength);
  }
  for (const chunk of result.packedChunks) {
    assert.equal(chunk.quads.byteLength, chunk.quadCount * 8);
    assert.equal(chunk.quads.buffer.byteLength, chunk.quads.byteLength);
    if (chunk.atlas) assert.equal(chunk.atlas.buffer.byteLength, chunk.atlasWidth * chunk.atlasHeight * 4);
    const base = chunk.bounds.min.map((c, axis) => Math.round((c - origin[axis]) / scale));
    for (let q = 0; q < chunk.quadCount; q++) {
      const quad = decodePackedQuad(chunk.quads, q);
      assert.ok(quad.axis <= 2);
      assert.ok(quad.position.every(c => c <= chunkSize));
      const d = quad.axis, u = (d + 1) % 3, v = (d + 2) % 3;
      for (let j = 0; j < quad.height; j++) for (let i = 0; i < quad.width; i++) {
        const p = quad.position.map((c, axis) => c + base[axis]);
        p[d] -= quad.sign > 0 ? 1 : 0; p[u] += i; p[v] += j;
        let rgb;
        if (quad.textured) {
          const at = (quad.payload + i + j * quad.width) * 4;
          assert.ok(at + 3 < chunk.atlas.length);
          assert.equal(chunk.atlas[at + 3], 255);
          rgb = Array.from(chunk.atlas.slice(at, at + 3)).join(',');
        } else {
          rgb = `${quad.payload & 255},${(quad.payload >>> 8) & 255},${(quad.payload >>> 16) & 255}`;
        }
        const key = `${p}|${d}|${quad.sign}|${rgb}`;
        assert.ok(!actual.has(key), `duplicate packed face ${key}`);
        actual.add(key);
      }
    }
  }
  assert.deepEqual(actual, expected);
  assert.equal(result.meshStats.visibleFaceCount, expected.size);
  return result;
}

const solid = 0xff332211;
checkSurface(1, 1, 1, () => 0, 4);
assert.equal(checkSurface(9, 5, 7, () => solid, 32).meshStats.quadCount, 6);
checkSurface(9, 5, 7, () => solid, 4);
checkSurface(8, 8, 8, (x, y, z) => x === 3 && y === 3 && z === 3 ? 0 : solid, 4);
checkSurface(9, 5, 7, (x, y, z) => (x + y + z) % 2 ? solid : 0, 4);
checkSurface(9, 5, 7, (x, y, z) => x === 3 && y === 2 && z === 2 ? solid : 0, 4);
checkSurface(9, 5, 7, (x, y, z) => (x + y + z) % 3 ? solid : 0xff000000, 4, { origin: [-100, 4, -20], voxelSize: 0.25 });
checkSurface(9, 5, 7, (x, y, z) => (x + y + z) % 3, 4, { paletteColors8: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]) });
checkSurface(32, 32, 32, (x, y, z) => (0xff000000 | x | (y << 8) | (z << 16)) >>> 0, 32);
const colorful = meshVoxelChunks(makeStore(32, 32, 32, (x, y, z) => (0xff000000 | x | (y << 8) | (z << 16)) >>> 0), { packed: true });
assert.equal(colorful.meshStats.quadCount, 6);
assert.equal(colorful.meshStats.geometryBytes, 48);
assert.ok(colorful.meshStats.atlasBytes > 0);
const packedSolid = meshVoxelChunks(makeStore(32, 32, 32, () => solid), { packed: true });
assert.equal(packedSolid.meshStats.atlasBytes, 0);
assert.equal(packedSolid.meshStats.geometryBytes, 48);
assert.throws(() => meshVoxelChunks(makeStore(1, 1, 1, () => solid, 64), { packed: true }), RangeError);
let seed = 123;
for (let run = 0; run < 20; run++) {
  const data = Array.from({ length: 11 * 9 * 7 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % 3 ? (solid + seed % 4) >>> 0 : 0;
  });
  checkSurface(11, 9, 7, (x, y, z) => data[x + 11 * (y + 9 * z)], 4);
}
const checker = meshVoxelChunks(makeStore(32, 32, 32, (x, y, z) => (x + y + z) % 2 ? solid : 0));
assert.ok(checker.geometries[0].indices instanceof Uint32Array);
assert.ok(checker.geometries[0].indices.every(i => i < checker.geometries[0].positions.length / 3));

const model = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial({ color: 0x8ec5ff }));
model.updateMatrixWorld(true);
const modelData = serializeModel(model);
const packedWorker = await new WorkerVoxelizer().init({ modelData, voxelSize: 0.1, renderMode: 'packed' });
assert.ok(packedWorker.packedChunks.length);
assert.equal(packedWorker.geometries.length, 0);
const packedExport = await new WorkerVoxelizer().init({ modelData, voxelSize: 0.1, renderMode: 'packed', needGrid: true });
assert.ok(packedExport.packedChunks.length);
assert.equal(packedExport.geometries.length, 0);
assert.deepEqual(packedExport.packedChunks, packedWorker.packedChunks);
assert.equal(packedExport.voxelGrid.sparse.indices.length, packedExport.voxelCount);
assert.ok(packedExport.voxelGrid);
for (const renderMode of ['mesh', 'surface']) {
  const withoutGrid = await new WorkerVoxelizer().init({ modelData, voxelSize: 0.1, renderMode });
  const withGrid = await new WorkerVoxelizer().init({ modelData, voxelSize: 0.1, renderMode, needGrid: true });
  assert.ok(withGrid.voxelCount > 0);
  assert.equal(withGrid.voxelCount, withoutGrid.voxelCount);
  assert.ok(withGrid.voxelGrid);
  assert.equal(withoutGrid.voxelGrid, null);
  assert.deepEqual(withGrid.geometries, withoutGrid.geometries);
}
console.log('Greedy mesher: unit-face oracle, seams, cavities, colors, winding, partial chunks, random grids, 32-bit indices and worker grid export passed.');
