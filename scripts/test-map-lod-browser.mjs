import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Exercise the actual map lifecycle with a synthetic source tile. The empty
// intercepted tileset keeps the check independent of map credentials/network.
let server, browser;
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false } });
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/THREE.WebGLProgram|INVALID_OPERATION|shader error/i.test(message.text())) errors.push(message.text()); });
  await page.route('**/v1/3dtiles/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    asset: { version: '1.1' }, geometricError: 0,
    root: { boundingVolume: { sphere: [6378137, 0, 0, 100] }, geometricError: 0, refine: 'REPLACE', children: [] },
  }) }));
  await page.addInitScript(() => { localStorage.setItem('coords', '0,0'); });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.tiles?.cameras?.length && window.getVoxelLodStats, null, { polling: 100 });
  await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const tiles = window.tiles;
    tiles.update = () => {}; // Drive source visibility events deterministically.
    tiles.group.position.set(0, 0, 0); tiles.group.quaternion.identity(); tiles.group.scale.setScalar(1); tiles.group.updateMatrixWorld(true);
    const tile = new THREE.Group(); tile.name = 'LOD test source';
    tile.add(new THREE.Mesh(new THREE.BoxGeometry(64, 64, 64), new THREE.MeshBasicMaterial({ color: 0x63c5e8 })));
    tiles.group.add(tile); window.lodTestTile = tile;
    tiles.cameras[0].position.set(100, 70, 100);
    tiles.dispatchEvent({ type: 'load-model', scene: tile });
    tiles.dispatchEvent({ type: 'tile-visibility-change', scene: tile, visible: true });
    window.lodInitialCoverage = window.getVoxelCoverageStats();
  });
  assert.deepEqual(await page.evaluate(() => window.lodInitialCoverage), {
    visible: 1, voxels: 0, fallback: 1, uncovered: 0, queued: 1, running: 0,
  });
  const ready = resolution => page.waitForFunction(res => window.lodTestTile?._voxResolution === res && window.getVoxelLodStats().pending === 0,
    resolution, { polling: 100, timeout: 20000 });
  await ready(64);
  assert.equal(await page.evaluate(() => window.lodTestTile.visible), false);
  assert.equal(await page.evaluate(() => window.getVoxelCoverageStats().uncovered), 0);
  const near = await page.evaluate(() => {
    window.lodNearMesh = window.lodTestTile._voxMesh;
    return window.getVoxelLodStats();
  });
  await page.evaluate(() => window.tiles.cameras[0].position.set(4000, 1000, 4000));
  await ready(8);
  const far = await page.evaluate(() => ({ ...window.getVoxelLodStats(), previousDetached: !window.lodNearMesh.parent,
    currentAttached: !!window.lodTestTile._voxMesh.parent, currentVisible: window.lodTestTile._voxMesh.visible }));
  assert.ok(far.previousDetached && far.currentAttached && far.currentVisible);
  await page.evaluate(() => window.tiles.cameras[0].position.set(100, 70, 100));
  await ready(64);
  const revisit = await page.evaluate(() => ({ ...window.getVoxelLodStats(), sameMesh: window.lodTestTile._voxMesh === window.lodNearMesh }));
  assert.ok(revisit.sameMesh);
  assert.equal(revisit.builds, far.builds);
  await page.evaluate(() => { const toggle = document.querySelector('#toggle-mc'); toggle.checked = true; toggle.dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => window.lodTestTile._mcApplied, null, { polling: 100 });
  const textured = await page.evaluate(() => ({ ...window.getVoxelLodStats(), sameMesh: window.lodTestTile._voxMesh === window.lodNearMesh,
    noExportGrid: !window.lodTestTile._voxelizer._voxelGrid,
    texturesEnabled: window.lodTestTile._voxMesh.children.every(mesh => mesh.material.uniforms.blockTextured.value && mesh.frustumCulled) }));
  assert.ok(textured.sameMesh && textured.noExportGrid && textured.texturesEnabled);
  assert.equal(textured.builds, revisit.builds);
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/map-lod.png', style: '#policy-banner { visibility: hidden !important; }' });
  // Returning to the active brightness must discard a pending lookup; an actual
  // replacement disposes the previous LUT while retaining all geometry.
  await page.evaluate(() => {
    window.lodOldLookup = window.lodTestTile._voxMesh.children[0].material.uniforms.blockRects.value;
    window.lodLookupDisposals = 0;
    window.lodOldLookup.addEventListener('dispose', () => window.lodLookupDisposals++);
    window.MC_setBrightness(0.2);
    window.MC_setBrightness(0);
  });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.lodTestTile._voxMesh.children[0].material.uniforms.blockRects.value === window.lodOldLookup), true);
  await page.evaluate(() => window.MC_setBrightness(0.2));
  await page.waitForFunction(() => window.lodTestTile._voxMesh.children[0].material.uniforms.blockRects.value !== window.lodOldLookup);
  assert.equal(await page.evaluate(() => window.lodLookupDisposals), 1);
  assert.equal(await page.evaluate(() => window.getVoxelLodStats().builds), revisit.builds);
  await page.evaluate(() => {
    window.lodTestTile.removeFromParent();
    window.tiles.dispatchEvent({ type: 'tile-visibility-change', scene: window.lodTestTile, visible: false });
  });
  assert.equal(await page.evaluate(() => window.lodTestTile._voxMesh.visible), false);
  await page.evaluate(() => {
    window.tiles.group.add(window.lodTestTile);
    window.tiles.dispatchEvent({ type: 'tile-visibility-change', scene: window.lodTestTile, visible: true });
  });
  await ready(64);
  assert.equal(await page.evaluate(() => window.lodTestTile._voxMesh.visible), true);
  // Changing the UI cap replaces the current variant without disposing it first.
  await page.evaluate(() => {
    const input = document.querySelector('#res-fine'); input.value = '128'; input.dispatchEvent(new Event('change'));
  });
  assert.equal(await page.evaluate(() => !!window.lodTestTile._voxMesh?.parent), true);
  await page.waitForFunction(() => !!window.lodTestTile._voxBuildToken, null, { polling: 5, timeout: 20000 });
  // Move close enough for the higher cap, then remove the tile during its rebuild.
  await page.evaluate(() => {
    window.tiles.cameras[0].position.set(45, 35, 45);
    window.tiles.dispatchEvent({ type: 'dispose-model', scene: window.lodTestTile });
    window.lodTestTile.removeFromParent();
  });
  await page.waitForFunction(() => window.getVoxelLodStats().entries === 0 && window.getVoxelLodStats().pending === 0, null, { polling: 100 });
  const disposed = await page.evaluate(() => ({ ...window.getVoxelLodStats(), meshRemoved: !window.lodTestTile._voxMesh && !window.lodNearMesh.parent }));
  assert.ok(disposed.meshRemoved);
  assert.equal(disposed.bytes, 0);
  assert.deepEqual(errors, []);
  const report = { initialCoverage: await page.evaluate(() => window.lodInitialCoverage), near, far, revisit, textured, disposed, errors };
  await mkdir('output/playwright', { recursive: true });
  await writeFile('output/playwright/map-lod.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await server?.close(); }
