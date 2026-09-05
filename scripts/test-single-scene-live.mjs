import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

// Real mobile-sized Single Scene capture/preview. Export checks use the separate
// procedural-asset test; this test never exports Earth data or checks confirmations.
let server, browser;
const targetUrl = process.env.VOXEL_BASE_URL;
const report = { target: targetUrl || 'local', errors: [], glbs: 0, json: 0 };
try {
  if (!targetUrl) {
    server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false } }); await server.listen();
  }
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  page.on('pageerror', e => report.errors.push(e.message.replace(/\?[^\s]+/g, '?[redacted]')));
  page.on('response', r => { const path = new URL(r.url()).pathname; if (r.ok() && path.includes('/3dtiles/')) {
    if (path.endsWith('.glb')) report.glbs++; if (path.endsWith('.json')) report.json++;
  } });
  await page.addInitScript(() => localStorage.setItem('coords', '48.85837,2.29448'));
  await page.goto(targetUrl || server.resolvedUrls.local[0]);
  await page.addStyleTag({ content: '#policy-banner { visibility:hidden !important; }' });
  await page.waitForFunction(() => window.tiles && window.getVoxelLodStats);
  await page.locator('#model-picker-btn').tap(); await page.locator('[data-model="single-scene"]').tap();
  await page.evaluate(() => {
    for (const [id, value] of [['single-scene-radius', '50'], ['single-scene-sse', '64'], ['single-scene-res-fine', '16']]) {
      const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('input'));
    }
  });
  const start = Date.now();
  await page.locator('#single-scene-fetch').tap();
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(5000);
    const status = await page.evaluate(() => ({ loaded: window.singleSceneViewer?.gltfArray.length,
      voxels: window.singleSceneViewer?.voxelizer?.voxelCount ?? 0, busy: document.querySelector('#single-scene-fetch').disabled }));
    console.log(JSON.stringify({ elapsedMs: Date.now() - start, ...status }));
    if (status.voxels && !status.busy) break;
  }
  report.previewMs = Date.now() - start;
  report.preview = await page.evaluate(async () => {
    const viewer = window.singleSceneViewer;
    await viewer.setMinecraftEnabled(true);
    return { loaded: viewer.gltfArray.length, voxels: viewer.voxelizer?.voxelCount,
      packed: viewer.voxelMeshes[0]?.children.every(m => !!m.geometry.getAttribute('packedQuad')),
      gridSparse: !!viewer.voxelizer?._voxelGrid.sparse, stats: viewer.voxelizer?.stats,
      drawCalls: viewer.renderer.info.render.calls, drawingBuffer: [viewer.renderer.domElement.width, viewer.renderer.domElement.height] };
  });
  assert.ok(report.preview.loaded > 0 && report.preview.voxels > 0 && report.preview.packed && report.preview.gridSparse);
  assert.deepEqual(report.errors, []);
  await page.locator('#single-scene-panel-toggle').tap();
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/single-scene-live-mobile.png' });
} catch (error) { report.failure = error.message; process.exitCode = 1; }
finally {
  await browser?.close(); await server?.close();
  await mkdir('output/playwright', { recursive: true });
  await writeFile('output/playwright/single-scene-live-mobile.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
