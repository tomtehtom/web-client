import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const name = process.env.VOXEL_BROWSER || 'chrome';
const report = { browser: name, errors: [], layouts: [] };
let server, browser;
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false } }); await server.listen();
  browser = await (name === 'webkit' ? webkit : chromium).launch({ headless: false, ...(name === 'webkit' ? {} : { channel: name }) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  page.setDefaultTimeout(30000);
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('console', m => { if (/THREE.WebGLProgram|INVALID_OPERATION|shader error/i.test(m.text())) report.errors.push(m.text()); });
  page.on('console', m => { if (m.text().startsWith('EXPORT TEST')) console.log(m.text()); });
  await page.route('**/v1/3dtiles/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    asset: { version: '1.1' }, geometricError: 0, root: { boundingVolume: { sphere: [6378137, 0, 0, 1] }, geometricError: 0, children: [] },
  }) }));
  await page.goto(server.resolvedUrls.local[0]);
  await page.addStyleTag({ content: '#policy-banner { visibility:hidden !important; }' });
  await page.waitForFunction(() => window.tiles && window.getVoxelLodStats);
  await page.locator('#model-picker-btn').tap();
  await page.locator('[data-model="single-scene"]').tap();
  await page.waitForFunction(() => !!window.singleSceneViewer);
  // Own procedural asset, never Earth-derived content. Exercise actual GLB loader.
  await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const { GLTFExporter } = await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(8, 6, 4), new THREE.MeshBasicMaterial({ color: 0x7b858c }));
    mesh.position.set(6378137, 0, 0); scene.add(mesh);
    const data = await new GLTFExporter().parseAsync(scene, { binary: true });
    const url = URL.createObjectURL(new Blob([data]));
    await window.singleSceneViewer.loadGLTFTiles([url]); URL.revokeObjectURL(url);
    const input = document.querySelector('#single-scene-res-fine'); input.value = '32'; input.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => window.singleSceneViewer.voxelizer?.voxelMesh);
  report.preview = await page.evaluate(() => {
    const v = window.singleSceneViewer;
    window.originalSingleMesh = v.voxelMeshes[0];
    return { packed: v.voxelMeshes[0].children.every(m => !!m.geometry.getAttribute('packedQuad')),
      sparseGrid: !!v.voxelizer._voxelGrid.sparse, gridDense: !!v.voxelizer._voxelGrid.voxelCounts,
      gridBytes: v.voxelizer._voxelGrid.sparse.indices.byteLength + v.voxelizer._voxelGrid.sparse.colors.byteLength,
      voxels: v.voxelizer.voxelCount, render: { ...v.renderer.info.render }, pixelRatio: v.renderer.getPixelRatio() };
  });
  assert.ok(report.preview.packed && report.preview.sparseGrid && !report.preview.gridDense);
  assert.equal(report.preview.pixelRatio, 1);
  // Mobile users must reach rendering options without the hidden footer.
  await page.locator('#single-scene-options').tap();
  await page.locator('label').filter({ has: page.locator('#toggle-mc') }).tap();
  await page.waitForFunction(() => window.singleSceneViewer.voxelMeshes[0].userData.__mcApplied);
  await page.locator('label').filter({ has: page.locator('#toggle-mc') }).tap();
  await page.locator('#menu-close').tap();
  const distance = () => page.evaluate(() => {
    const v = window.singleSceneViewer; return v.camera.position.distanceTo(v.controls.target);
  });
  const beforeZoom = await distance();
  await page.locator('#zoom-in-btn').tap();
  assert.ok(await distance() < beforeZoom, 'Zoom buttons must move the visible Single Scene camera');
  await page.locator('#zoom-out-btn').tap();
  const beforeTilt = await page.evaluate(() => window.singleSceneViewer.camera.position.toArray());
  await page.locator('#tilt-up-btn').tap();
  assert.notDeepEqual(await page.evaluate(() => window.singleSceneViewer.camera.position.toArray()), beforeTilt);
  // Rapid sampling-rotation changes cancel obsolete work and keep the old mesh
  // attached until the latest replacement is ready.
  await page.evaluate(() => {
    const input = document.querySelector('#single-scene-rot');
    for (const value of ['15', '37']) { input.value = value; input.dispatchEvent(new Event('input')); }
    window.singleOldRetained = !!window.originalSingleMesh.parent;
  });
  assert.equal(await page.evaluate(() => window.singleOldRetained), true);
  await page.waitForFunction(() => window.singleSceneViewer.voxelMeshes[0] !== window.originalSingleMesh);
  await page.evaluate(() => { window.originalSingleMesh = window.singleSceneViewer.voxelMeshes[0]; });
  report.exports = await page.evaluate(() => Promise.race([(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const v = window.singleSceneViewer, results = {};
    for (const textured of [false, true]) {
      console.log('EXPORT TEST', textured ? 'textured' : 'colored');
      await v.setMinecraftEnabled(textured);
      const start = performance.now(), bytes = await v.exportGlb();
      console.log('EXPORT TEST GLB encoded', bytes.byteLength);
      const gltf = await new GLTFLoader().parseAsync(bytes, '');
      let triangles = 0, texturedMeshes = 0;
      gltf.scene.traverse(n => { if (n.isMesh) { triangles += (n.geometry.index?.count ?? n.geometry.attributes.position.count) / 3; if (n.material.map) texturedMeshes++; } });
      const box = new THREE.Box3().setFromObject(gltf.scene);
      results[textured ? 'texturedGlb' : 'coloredGlb'] = { bytes: bytes.byteLength, ms: performance.now() - start, triangles, texturedMeshes,
        bounds: [box.min.toArray(), box.max.toArray()] };
      if (textured) {
        const target = new THREE.WebGLRenderTarget(257, 257);
        const center = box.getCenter(new THREE.Vector3());
        const span = box.getSize(new THREE.Vector3()).length();
        const camera = new THREE.OrthographicCamera(-span * .6, span * .6, span * .6, -span * .6, .01, span * 10);
        // Subpixel offset avoids deliberately sampling exact nearest-texel edges.
        camera.setViewOffset(257, 257, .37, .23, 257, 257);
        camera.layers.enable(1);
        const pixels = root => {
          v.renderer.setRenderTarget(target); v.renderer.render(root, camera);
          const bytes = new Uint8Array(257 * 257 * 4); v.renderer.readRenderTargetPixels(target, 0, 0, 257, 257, bytes); return bytes;
        };
        results.texturePixels = [];
        for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
          camera.position.copy(center); camera.position.setComponent(axis, center.getComponent(axis) + sign * span * 2);
          camera.up.set(0, axis === 1 ? 0 : 1, axis === 1 ? 1 : 0); camera.lookAt(center); camera.updateMatrixWorld(true);
          const a = pixels(v.scene), b = pixels(gltf.scene);
          let mismatches = 0;
          for (let i = 0; i < a.length; i += 4) if ([0, 1, 2].some(c => Math.abs(a[i + c] - b[i + c]) > 2)) mismatches++;
          results.texturePixels.push({ axis, sign, mismatches });
        }
        v.renderer.setRenderTarget(null); target.dispose();
      }
      gltf.scene.traverse(n => { n.geometry?.dispose(); n.material?.map?.dispose(); n.material?.dispose(); });
    }
    results.sameMesh = v.voxelMeshes[0] === window.originalSingleMesh;
    for (const format of ['nbt', 'schem', 'schematic', 'mcfunction']) {
      console.log('EXPORT TEST', format);
      const start = performance.now();
      const bytes = await v.exportSession.run(v.voxelizer._voxelGrid, format);
      results[format] = { bytes: bytes.byteLength, ms: performance.now() - start, header: [...bytes.slice(0, 10)] };
    }
    return results;
  })(), new Promise((_, reject) => setTimeout(() => reject(new Error('Export test timed out')), 25000))]));
  assert.ok(report.exports.sameMesh);
  assert.ok(report.exports.texturedGlb.texturedMeshes > 0);
  // glTF's float32 transforms can select the neighboring nearest texel at a
  // rotated edge; allow under 0.1% of pixels, while catching UV/material changes.
  assert.ok(report.exports.texturePixels.every(v => v.mismatches < 257 * 257 * .001), JSON.stringify(report.exports.texturePixels));
  assert.deepEqual(report.exports.coloredGlb.bounds, report.exports.texturedGlb.bounds);
  assert.equal(report.exports.coloredGlb.triangles, report.exports.texturedGlb.triangles);
  for (const fmt of ['nbt', 'schem', 'schematic']) assert.deepEqual(report.exports[fmt].header.slice(0, 2), [31, 139]);
  await mkdir('output/playwright', { recursive: true });
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('#single-scene-panel').getBoundingClientRect();
      return { viewport: [innerWidth, innerHeight], panel: { x: panel.x, y: panel.y, right: panel.right, bottom: panel.bottom },
        overflow: document.documentElement.scrollWidth > innerWidth,
        buttonHeight: document.querySelector('#single-scene-panel-toggle').getBoundingClientRect().height };
    });
    report.layouts.push(layout);
    assert.ok(!layout.overflow && layout.panel.x >= 0 && layout.panel.y >= 0 && layout.panel.right <= viewport.width && layout.panel.bottom <= viewport.height);
    assert.ok(layout.buttonHeight >= 44);
    await page.screenshot({ path: `output/playwright/single-scene-${name}-${viewport.width}.png` });
  }
  await page.locator('#single-scene-panel-toggle').tap();
  assert.equal(await page.locator('#single-scene-panel-toggle').getAttribute('aria-expanded'), 'false');
  // The preview remains touch-operable above the collapsed sheet.
  await page.evaluate(() => { window.singleCameraBefore = window.singleSceneViewer.camera.position.toArray(); });
  if (name !== 'webkit') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 180 }] });
    for (let x = 110; x <= 220; x += 10) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 180 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok(await page.evaluate(() => window.singleSceneViewer.camera.position.toArray().some((v, i) => Math.abs(v - window.singleCameraBefore[i]) > .01)));
    await page.waitForTimeout(400); // Let synthesized compatibility clicks settle.
  }
  await page.locator('#single-scene-panel-toggle').tap();
  // The only loaded asset is our procedural box, so these assertions are true.
  await page.locator('#single-scene-confirm-no-photoreal').check();
  await page.locator('#single-scene-confirm-rights').check();
  const downloaded = page.waitForEvent('download');
  await page.locator('#export-glb-btn').tap();
  const download = await downloaded;
  await download.saveAs(`output/playwright/single-scene-${name}.glb`);
  report.download = download.suggestedFilename();
  await page.screenshot({ path: `output/playwright/single-scene-${name}-export-controls.png` });
  await page.locator('#single-scene-panel-toggle').tap();
  await page.evaluate(() => { window.closedSingleViewer = window.singleSceneViewer; window.closedSingleFrame = window.closedSingleViewer.renderer.info.render.frame; });
  await page.locator('#model-picker-btn').tap();
  console.log('EXPORT TEST menu', await page.locator('#model-picker-menu').getAttribute('class'));
  await page.locator('[data-model="voxel-earth"]').tap();
  await page.evaluate(() => { window.closedSingleFrame = window.closedSingleViewer.renderer.info.render.frame; });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.closedSingleViewer.renderer.info.render.frame), await page.evaluate(() => window.closedSingleFrame));
  assert.deepEqual(report.errors, []);
} catch (error) { report.failure = error.stack; process.exitCode = 1; }
finally {
  await browser?.close(); await server?.close();
  await mkdir('output/playwright', { recursive: true });
  await writeFile(`output/playwright/single-scene-${name}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
