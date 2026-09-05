import * as THREE from 'three';
import { meshVoxelChunks } from '../src/greedy-mesher.js';
import { makeMillionVoxelFixture, makeStore } from './voxel-fixtures.mjs';
import { voxelizeModel, invalidateSerializedModel } from '../src/voxelize-model.js';
import { createPackedVoxelMesh, setPackedVoxelTextures } from '../src/packed-voxel-renderer.js';
import { VoxelLodCache } from '../src/voxel-lod.js';
import { batchPackedVoxelChunks } from '../src/packed-voxel-batching.js';

const nextFrame = () => new Promise((resolve, reject) => {
  // Browsers can suspend RAF for covered/background windows even during a test.
  // Fail visibly rather than leaving the benchmark button disabled indefinitely.
  const timeout = setTimeout(() => {
    cancelAnimationFrame(frame);
    reject(new Error('Frame callbacks paused. Bring the benchmark window into view and run again.'));
  }, 5000);
  const frame = requestAnimationFrame(time => { clearTimeout(timeout); resolve(time); });
});
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x151c1f);
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 2000);
let group = null;

function disposeGroup() {
  if (!group) return;
  scene.remove(group);
  const materials = new Set();
  group.traverse(node => {
    node.geometry?.dispose();
    if (node.material) materials.add(node.material);
  });
  for (const material of materials) material.dispose();
  group = null;
}

function buildGroup(result) {
  const meshes = new THREE.Group();
  for (const chunk of result.packedChunks) meshes.add(createPackedVoxelMesh(chunk));
  const material = result.geometries.length ? new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }) : null;
  for (const g of result.geometries) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(g.colors8, 4, true));
    geometry.setIndex(new THREE.BufferAttribute(g.indices, 1));
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...g.bounds.min), new THREE.Vector3(...g.bounds.max));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    meshes.add(mesh);
  }
  return meshes;
}

export async function runRenderBenchmark({ fixture = 'terrain', packed = true, width = 3840, height = 2160, frames = 120 } = {}) {
  disposeGroup();
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  const store = makeMillionVoxelFixture(fixture);
  const start = performance.now();
  const result = meshVoxelChunks(store, { packed });
  const meshMs = performance.now() - start;
  group = buildGroup(result);
  scene.add(group);
  const center = new THREE.Vector3(store.indexer.nx / 2, store.indexer.ny / 2, store.indexer.nz / 2);
  const radius = Math.max(store.indexer.nx, store.indexer.ny, store.indexer.nz) * 1.65;
  const draw = (frame) => {
    const angle = 0.6 + frame * 0.003;
    camera.position.set(center.x + Math.cos(angle) * radius, center.y + radius * 0.7, center.z + Math.sin(angle) * radius);
    camera.lookAt(center);
    renderer.render(scene, camera);
  };
  const gl = renderer.getContext();
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const gpuRenderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
  const pending = [], gpuTimes = [], frameTimes = [], cpuTimes = [];
  const poll = () => {
    if (!timer) return;
    if (gl.getParameter(timer.GPU_DISJOINT_EXT)) {
      for (const query of pending) gl.deleteQuery(query);
      pending.length = 0;
      gpuTimes.length = 0;
      return;
    }
    while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const query = pending.shift();
      gpuTimes.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(query);
    }
  };
  // Uploads and shader compilation are warm-up, outside steady-state samples.
  for (let i = 0; i < 30; i++) { await nextFrame(); draw(i); }
  let previous = await nextFrame();
  for (let i = 0; i < frames; i++) {
    const now = await nextFrame();
    frameTimes.push(now - previous); previous = now;
    poll();
    const query = timer && pending.length < 4 ? gl.createQuery() : null;
    if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    const cpuStart = performance.now();
    draw(i);
    cpuTimes.push(performance.now() - cpuStart);
    if (query) { gl.endQuery(timer.TIME_ELAPSED_EXT); pending.push(query); }
  }
  for (let i = 0; i < 30 && pending.length; i++) { await nextFrame(); poll(); }
  for (const query of pending) gl.deleteQuery(query);
  const report = {
    fixture, packed, userAgent: navigator.userAgent, gpuRenderer, width, height,
    voxels: store.voxelCount, meshMs, ...result.meshStats,
    submittedDrawCalls: renderer.info.render.calls, submittedTriangles: renderer.info.render.triangles,
    frameMsP50: percentile(frameTimes, 0.5), frameMsP95: percentile(frameTimes, 0.95),
    cpuSubmitMsP50: percentile(cpuTimes, 0.5), cpuSubmitMsP95: percentile(cpuTimes, 0.95),
    gpuMsP50: percentile(gpuTimes, 0.5), gpuMsP95: percentile(gpuTimes, 0.95), gpuSamples: gpuTimes.length,
    webglError: gl.getError(), visibility: document.visibilityState,
  };
  // A camera facing away must cull every chunk; guards missing/stale bounds.
  camera.position.set(-100, -100, -100); camera.lookAt(-200, -200, -200);
  renderer.render(scene, camera);
  report.awayDrawCalls = renderer.info.render.calls;
  draw(0);
  return report;
}

export async function runWorkerSmoke() {
  const colorData = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    colorData.set([x * 17, y * 17, (x ^ y) * 17, 255], (x + y * 16) * 4);
  }
  const sourceTexture = new THREE.DataTexture(colorData, 16, 16);
  sourceTexture.colorSpace = THREE.SRGBColorSpace;
  const model = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2, 40, 40, 40), new THREE.MeshBasicMaterial({ color: 0x8ec5ff, map: sourceTexture }));
  model.updateMatrixWorld(true);
  const workerScene = new THREE.Scene();
  const workerCamera = new THREE.PerspectiveCamera(50, camera.aspect, 0.1, 100);
  workerCamera.position.set(4, 3, 4);
  workerCamera.lookAt(0, 0, 0);
  const reports = [];
  try {
    for (const method of ['2.5d-scan', 'rust-wasm', 'webgpu']) {
      const result = await voxelizeModel({ model, renderer, resolution: 128, method, renderMode: 'packed' });
      if (!result.voxelMesh.children.length) throw new Error(`${method}: no geometry`);
      if (!result.stats.mesh.atlasBytes) throw new Error(`${method}: textured worker output omitted its atlas`);
      const expectedShell = 128 ** 3 - 126 ** 3;
      if (result.voxelCount !== expectedShell) throw new Error(`${method}: box boundary coverage ${result.voxelCount}, expected ${expectedShell}`);
      if (result.stats.totalMs < result.stats.workerMs) throw new Error('End-to-end timing omitted worker startup/transport');
      workerScene.add(result.voxelMesh);
      renderer.render(workerScene, workerCamera);
      if (!renderer.info.render.triangles) throw new Error(`${method}: mesh was not drawn`);
      reports.push({ requested: method, ...result.stats, voxelCount: result.voxelCount, drawnTriangles: renderer.info.render.triangles, webglError: renderer.getContext().getError() });
      workerScene.remove(result.voxelMesh);
      const materials = new Set();
      result.voxelMesh.traverse(node => { node.geometry?.dispose(); if (node.material) materials.add(node.material); });
      for (const material of materials) material.dispose();
    }
    return reports;
  } finally { model.geometry.dispose(); model.material.dispose(); sourceTexture.dispose(); }
}

export async function runPackedPixelCheck() {
  const store = makeStore(35, 9, 13, (x, y, z) => {
    if (x > 8 && x < 13 && y > 3 && z > 4 && z < 8) return 0;
    return (0xff000000 | (x * 7) | (y * 27 << 8) | (z * 19 << 16)) >>> 0;
  });
  const options = { origin: [-100, 4, -20], voxelSize: 0.25 };
  const regular = buildGroup(meshVoxelChunks(store, options));
  const packedResult = meshVoxelChunks(store, { ...options, packed: true });
  packedResult.packedChunks = batchPackedVoxelChunks(packedResult.packedChunks);
  const packed = buildGroup(packedResult);
  const checkScene = new THREE.Scene(); checkScene.background = new THREE.Color(0x010203);
  const checkCamera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
  const target = new THREE.WebGLRenderTarget(256, 256);
  const previousTarget = renderer.getRenderTarget();
  const before = { ...renderer.info.memory };
  const center = new THREE.Vector3(-100 + 35 * 0.125, 4 + 9 * 0.125, -20 + 13 * 0.125);
  const imageA = new Uint8Array(256 * 256 * 4), imageB = new Uint8Array(imageA.length);
  const views = [];
  try {
    renderer.setRenderTarget(target);
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      checkCamera.position.copy(center); checkCamera.position.setComponent(axis, center.getComponent(axis) + sign * 30);
      checkCamera.up.set(0, axis === 1 ? 0 : 1, axis === 1 ? 1 : 0); checkCamera.lookAt(center);
      checkScene.add(regular); renderer.render(checkScene, checkCamera);
      renderer.readRenderTargetPixels(target, 0, 0, 256, 256, imageA); checkScene.remove(regular);
      checkScene.add(packed); renderer.render(checkScene, checkCamera);
      renderer.readRenderTargetPixels(target, 0, 0, 256, 256, imageB); checkScene.remove(packed);
      let mismatches = 0, maxError = 0, coloredPixels = 0;
      for (let at = 0; at < imageA.length; at += 4) {
        if (imageA[at] > 2 || imageA[at + 1] > 2 || imageA[at + 2] > 2) coloredPixels++;
        const error = Math.max(...[0, 1, 2].map(c => Math.abs(imageA[at + c] - imageB[at + c])));
        if (error > 1) mismatches++;
        maxError = Math.max(maxError, error);
      }
      views.push({ axis, sign, mismatches, maxError, coloredPixels });
      if (mismatches || coloredPixels < 100) throw new Error(`Packed pixel mismatch: ${JSON.stringify(views)}`);
    }
  } finally {
    renderer.setRenderTarget(previousTarget);
    target.dispose();
    const materials = new Set();
    for (const meshes of [regular, packed]) meshes.traverse(node => { node.geometry?.dispose(); if (node.material) materials.add(node.material); });
    for (const material of materials) material.dispose();
  }
  const after = { ...renderer.info.memory };
  if (before.geometries !== after.geometries || before.textures !== after.textures) {
    throw new Error(`Packed resource leak: ${JSON.stringify({ before, after })}`);
  }
  return { views, before, after, webglError: renderer.getContext().getError() };
}

export async function runLodWorkerCheck() {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const timeout = (promise, ms = 15000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('LOD worker test timed out')), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  const dispose = result => {
    result.voxelMesh.removeFromParent();
    const materials = new Set();
    result.voxelMesh.traverse(node => { node.geometry?.dispose(); if (node.material) materials.add(node.material); });
    for (const material of materials) material.dispose();
  };
  const model = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2, 4, 4, 4), new THREE.MeshBasicMaterial({ color: 0x6ac3ef }));
  const localScene = new THREE.Scene();
  const localCamera = new THREE.PerspectiveCamera(50, camera.aspect, 0.1, 100);
  localCamera.position.set(4, 3, 4); localCamera.lookAt(0, 0, 0);
  const before = { ...renderer.info.memory }, builds = [];
  const NativeWorker = window.Worker;
  let workersCreated = 0;
  window.Worker = class extends NativeWorker { constructor(...args) { super(...args); workersCreated++; } };
  const cache = new VoxelLodCache({ maxBytes: 1024 * 1024, onDispose: dispose,
    onActivate: (tile, entry, previous) => {
      localScene.add(entry.result.voxelMesh);
      previous?.result.voxelMesh.removeFromParent();
      check(localScene.children.length === 1, 'LOD swap did not leave exactly one mesh');
      renderer.render(localScene, localCamera);
      check(renderer.info.render.triangles > 0, 'LOD swap rendered a hole');
    },
  });
  const options = { model, renderer, method: '2.5d-scan', renderMode: 'packed' };
  try {
    for (const resolution of [16, 32, 64]) {
      const previous = cache.current(model)?.result.voxelMesh;
      const { token } = cache.request(model, resolution, 'packed');
      const result = await timeout(voxelizeModel({ ...options, resolution, onStart: controller => cache.setController(token, controller) }));
      if (previous) check(previous.parent === localScene, 'Previous LOD disappeared during build');
      cache.stage(token, result); cache.commit(token);
      builds.push({ resolution, totalMs: result.stats.totalMs, workerMs: result.stats.workerMs });
    }
    check(workersCreated <= 1, 'Sequential LOD builds created unused/new workers');
    const warmWorkerCount = workersCreated;
    const statsBeforeHit = cache.stats();
    const startHit = performance.now();
    check(cache.request(model, 16, 'packed', { allowBuild: false }).status === 'cached', 'Cached LOD not reused while build budget is full');
    const cacheHitMs = performance.now() - startHit;
    check(cache.stats().builds === statsBeforeHit.builds, 'Cache hit rebuilt geometry');

    // Cancel before dispatch, while running, and while waiting behind four jobs.
    const cancelled = promise => timeout(promise.then(result => { dispose(result); throw new Error('Cancelled job resolved'); }, error => {
      check(error.message === 'Voxelization cancelled', `Wrong cancellation error: ${error.message}`);
      return error.message;
    }));
    await cancelled(voxelizeModel({ ...options, resolution: 16, onStart: controller => controller.terminate() }));
    const controllers = [];
    const jobs = Array.from({ length: 5 }, () => cancelled(voxelizeModel({ ...options, resolution: 64, onStart: controller => controllers.push(controller) })));
    check(controllers.length === 5, 'Queued work did not expose cancellation');
    for (const controller of [...controllers].reverse()) controller.terminate();
    await Promise.all(jobs);

    // Cancellation must also settle after a worker finishes but reconstruction
    // is paused by camera interaction. Resuming must not attach stale output.
    let controller, release, markPaused;
    const gate = new Promise(resolve => { release = resolve; });
    const paused = new Promise(resolve => { markPaused = resolve; });
    let shouldPause = true;
    const rebuilding = cancelled(voxelizeModel({ ...options, resolution: 32,
      onStart: value => { controller = value; },
      mainThreadPolicy: { shouldPause: () => shouldPause, waitForIdle: () => { markPaused(); return gate; } },
    }));
    await timeout(paused); controller.terminate(); await rebuilding;
    shouldPause = false; release();
    const recovered = await timeout(voxelizeModel({ ...options, resolution: 16 }));
    check(recovered.voxelCount > 0, 'Worker pool failed to recover after cancellation'); dispose(recovered);
    // World transforms invalidate cached source serialization when retargeting.
    model.position.set(20, 0, 0); model.updateMatrixWorld(true); invalidateSerializedModel(model);
    const moved = await timeout(voxelizeModel({ ...options, resolution: 16 }));
    const movedBounds = new THREE.Box3().setFromObject(moved.voxelMesh);
    check(movedBounds.min.x >= 18.9, 'Retarget reused stale serialized transforms'); dispose(moved);
    cache.clear();
    renderer.render(localScene, localCamera);
    const after = { ...renderer.info.memory };
    check(before.geometries === after.geometries && before.textures === after.textures, `LOD resources leaked: ${JSON.stringify({ before, after })}`);
    return { builds, cacheHitMs, warmWorkerCount, cancellations: 7, before, after, webglError: renderer.getContext().getError() };
  } finally {
    window.Worker = NativeWorker;
    cache.clear(); model.geometry.dispose(); model.material.dispose();
  }
}

export function runBlockTexturePixelCheck() {
  const before = { ...renderer.info.memory };
  const data = new Uint8Array(32 * 32 * 4), sub = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) data.set([x * 8, y * 8, (x ^ y) * 8, 255], (x + y * 32) * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) sub.set(data.subarray(((x + 8) + (y + 8) * 32) * 4, ((x + 8) + (y + 8) * 32) * 4 + 4), (x + y * 16) * 4);
  const atlas = new THREE.DataTexture(data, 32, 32), referenceTexture = new THREE.DataTexture(sub, 16, 16);
  for (const texture of [atlas, referenceTexture]) { texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true; }
  referenceTexture.wrapS = referenceTexture.wrapT = THREE.RepeatWrapping;
  const rects = new Float32Array(65536 * 4);
  for (let i = 0; i < 65536; i++) rects.set([0.25, 0.25, 0.5, 0.5], i * 4);
  const lookup = new THREE.DataTexture(rects, 256, 256, THREE.RGBAFormat, THREE.FloatType); lookup.needsUpdate = true;
  const result = meshVoxelChunks(makeStore(35, 3, 5, () => 0xffffffff), { packed: true });
  result.packedChunks = batchPackedVoxelChunks(result.packedChunks);
  const packed = buildGroup(result); setPackedVoxelTextures(packed, { lookup, atlas }, true);
  const geometry = new THREE.BoxGeometry(35, 3, 5); geometry.translate(17.5, 1.5, 2.5);
  const p = geometry.attributes.position, normal = geometry.attributes.normal, uv = geometry.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    if (normal.getX(i)) uv.setXY(i, normal.getX(i) * p.getZ(i), p.getY(i));
    else if (normal.getY(i)) uv.setXY(i, p.getX(i), normal.getY(i) * p.getZ(i));
    else uv.setXY(i, normal.getZ(i) * p.getX(i), p.getY(i));
  }
  const regular = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: referenceTexture, toneMapped: false }));
  const checkScene = new THREE.Scene(); checkScene.background = new THREE.Color(0x010203);
  const checkCamera = new THREE.OrthographicCamera(-19.3, 19.3, 19.3, -19.3, 0.1, 100);
  const center = new THREE.Vector3(17.5, 1.5, 2.5), target = new THREE.WebGLRenderTarget(256, 256);
  const previous = renderer.getRenderTarget(), a = new Uint8Array(256 * 256 * 4), b = new Uint8Array(a.length), views = [];
  try {
    renderer.setRenderTarget(target);
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      checkCamera.position.copy(center); checkCamera.position.setComponent(axis, center.getComponent(axis) + sign * 40);
      checkCamera.up.set(0, axis === 1 ? 0 : 1, axis === 1 ? 1 : 0); checkCamera.lookAt(center);
      checkScene.add(regular); renderer.render(checkScene, checkCamera); renderer.readRenderTargetPixels(target, 0, 0, 256, 256, a); checkScene.remove(regular);
      checkScene.add(packed); renderer.render(checkScene, checkCamera); renderer.readRenderTargetPixels(target, 0, 0, 256, 256, b); checkScene.remove(packed);
      let mismatches = 0;
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1) mismatches++;
      views.push({ axis, sign, mismatches });
      if (mismatches) throw new Error(`Block texture orientation/repeat mismatch: ${JSON.stringify(views)}`);
    }
  } finally {
    renderer.setRenderTarget(previous); target.dispose(); geometry.dispose(); regular.material.dispose();
    packed.traverse(node => { node.geometry?.dispose(); node.material?.dispose(); });
    atlas.dispose(); referenceTexture.dispose(); lookup.dispose();
  }
  const after = { ...renderer.info.memory };
  if (before.geometries !== after.geometries || before.textures !== after.textures) throw new Error('Block texture check leaked resources');
  return { views, before, after };
}
window.runBlockTexturePixelCheck = runBlockTexturePixelCheck;
window.runLodWorkerCheck = runLodWorkerCheck;
window.runMesherTimingCheck = async ({ deferred = false } = {}) => {
  // Compare debugger-evaluated execution with a normal event-loop task. Some
  // engines inhibit optimization while a debugger evaluation is on the stack.
  if (deferred) await new Promise(resolve => setTimeout(resolve, 0));
  const store = makeMillionVoxelFixture('colored');
  const timings = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const result = meshVoxelChunks(store, { packed: true });
    timings.push(performance.now() - start);
    if (result.meshStats.triangleCount !== 40756) throw new Error('CPU fixture changed');
  }
  return { deferred, timings };
};
window.runRenderBenchmark = runRenderBenchmark;
window.runWorkerSmoke = runWorkerSmoke;
window.runPackedPixelCheck = runPackedPixelCheck;
document.querySelector('#run').addEventListener('click', async () => {
  const button = document.querySelector('#run'), output = document.querySelector('#result');
  button.disabled = true;
  output.textContent = 'Measuring…';
  try { output.textContent = JSON.stringify(await runRenderBenchmark({ fixture: document.querySelector('#fixture').value, packed: document.querySelector('#mode').value === 'packed' }), null, 2); }
  catch (error) { output.textContent = error.stack; }
  finally { button.disabled = false; }
});
