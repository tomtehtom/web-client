import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, firefox } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

// Actual Paris preset and live Earth traffic; no route mocks or saved GLBs.
const name = process.env.VOXEL_BROWSER || 'chrome';
const targetUrl = process.env.VOXEL_BASE_URL;
const report = { browser: name, target: targetUrl || 'local', errors: [], samples: [] };
let server, browser;
try {
  if (!targetUrl) {
    server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false } });
    await server.listen();
  }
  browser = await (name === 'firefox' ? firefox : chromium).launch({ headless: false,
    ...(name === 'firefox' ? { firefoxUserPrefs: { 'widget.windows.window_occlusion_tracking.enabled': false } } : { channel: name }) });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(error.message.replace(/\?[^\s]+/g, '?[redacted]')));
  page.on('console', message => { if (/THREE.WebGLProgram|INVALID_OPERATION|shader error/i.test(message.text())) report.errors.push(message.text()); });
  await page.addInitScript(() => localStorage.setItem('coords', '48.85837,2.29448'));
  await page.goto(targetUrl || server.resolvedUrls.local[0]);
  // Test profile only: let pointer events reach the map without accepting terms.
  await page.addStyleTag({ content: '#policy-banner { visibility: hidden !important; }' });
  await page.waitForFunction(() => window.getVoxelCoverageStats && window.tiles?.cameras.length);
  await page.getByRole('button', { name: 'Paris', exact: true }).click({ force: true });
  await page.evaluate(() => {
    window.coverageFrames = { samples: 0, uncovered: 0, maxFallback: 0, firstSourceMs: null, firstVoxelMs: null, intervals: [] };
    let previous, started = performance.now();
    const tick = time => {
      const s = window.getVoxelCoverageStats(), f = window.coverageFrames;
      f.samples++; f.uncovered += s.uncovered; f.maxFallback = Math.max(f.maxFallback, s.fallback);
      if (s.visible && f.firstSourceMs === null) f.firstSourceMs = time - started;
      if (s.voxels && f.firstVoxelMs === null) f.firstVoxelMs = time - started;
      if (previous) f.intervals.push(time - previous);
      previous = time; requestAnimationFrame(tick);
    }; requestAnimationFrame(tick);
  });
  const sample = async stage => {
    const result = await page.evaluate(stage => ({ stage, ...window.getVoxelCoverageStats(), cache: window.getVoxelLodStats(),
      render: window.getVoxelRenderStats(), streamed: { ...window.tiles.stats } }), stage);
    report.samples.push(result); console.log(JSON.stringify(result));
  };
  await mkdir('output/playwright', { recursive: true });
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2000); await sample(`loading-${i}`);
    if (i === 1) await page.screenshot({ path: `output/playwright/earth-coverage-${name}-loading.png`, style: '#policy-banner { visibility:hidden !important; }' });
  }
  await page.evaluate(() => {
    const toggle = document.querySelector('#toggle-mc'); toggle.checked = true; toggle.dispatchEvent(new Event('change'));
  });
  report.cameraBefore = await page.evaluate(() => window.tiles.cameras[0].position.toArray());
  // Actual drag events exercise interaction gating, not just a camera teleport.
  await page.mouse.move(800, 400); await page.mouse.down();
  for (let i = 1; i <= 80; i++) {
    await page.mouse.move(800 + i * 4, 400 + Math.sin(i / 12) * 40);
    await page.waitForTimeout(50);
    if (i % 20 === 0) await sample(`drag-${i}`);
  }
  await page.mouse.up();
  report.cameraAfter = await page.evaluate(() => window.tiles.cameras[0].position.toArray());
  assert.ok(report.cameraBefore.some((v, i) => Math.abs(v - report.cameraAfter[i]) > 1), 'Pointer drag must actually move the camera');
  await page.screenshot({ path: `output/playwright/earth-coverage-${name}-moving.png`, style: '#policy-banner { visibility:hidden !important; }' });
  for (let i = 0; i < 6; i++) { await page.waitForTimeout(3000); await sample(`settled-${i}`); }
  await page.screenshot({ path: `output/playwright/earth-coverage-${name}-settled.png`, style: '#policy-banner { visibility:hidden !important; }' });
  report.frames = await page.evaluate(() => {
    const { intervals, ...f } = window.coverageFrames;
    intervals.sort((a, b) => a - b);
    return { ...f, p50: intervals[Math.floor(intervals.length * .5)], p95: intervals[Math.floor(intervals.length * .95)] };
  });
  report.version = browser.version();
  assert.equal(report.frames.uncovered, 0, 'Loaded visible tiles must always have source or voxel coverage');
  assert.ok(report.frames.maxFallback > 0, 'Must exercise source fallback while voxels build');
  assert.ok(report.samples.at(-1).voxels > 0, 'Real Paris voxels must render');
  assert.deepEqual(report.errors, []);
} catch (error) { report.failure = error.message; process.exitCode = 1; }
finally {
  await browser?.close(); await server?.close();
  await mkdir('output/playwright', { recursive: true });
  await writeFile(`output/playwright/earth-coverage-${name}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ frames: report.frames, failure: report.failure, errors: report.errors }));
}
