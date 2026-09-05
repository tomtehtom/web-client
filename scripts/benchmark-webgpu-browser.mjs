import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';

// Headed by default: background/headless compositor scheduling can distort FPS.
// VOXEL_BROWSER may be chrome, msedge, firefox or webkit.
const name = process.env.VOXEL_BROWSER ?? 'chrome';
const checksOnly = process.env.VOXEL_CHECKS_ONLY === '1';
const engines = { chrome: chromium, msedge: chromium, firefox, webkit };
if (!engines[name]) throw new Error(`Unsupported VOXEL_BROWSER: ${name}`);
let server, browser;
const errors = [];
const report = { capturedAt: new Date().toISOString(), browser: name, checksOnly, errors };
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false } });
  await server.listen();
  browser = await engines[name].launch({
    ...(name === 'chrome' || name === 'msedge' ? { channel: name } : {}),
    headless: false,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  report.version = browser.version();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/voxel-render-benchmark.html`);
  await page.waitForFunction(() => typeof window.runRenderBenchmark === 'function');
  await page.bringToFront();
  report.pixels = await page.evaluate(() => window.runPackedPixelCheck());
  report.blockTextures = await page.evaluate(() => window.runBlockTexturePixelCheck());
  report.lod = await page.evaluate(() => window.runLodWorkerCheck());
  report.workers = await page.evaluate(() => window.runWorkerSmoke());
  report.mesher = {
    direct: await page.evaluate(() => window.runMesherTimingCheck()),
    deferred: await page.evaluate(() => window.runMesherTimingCheck({ deferred: true })),
  };
  if (!checksOnly) {
    await page.bringToFront();
    report.baseline = await page.evaluate(() => window.runRenderBenchmark({ fixture: 'colored', packed: false }));
    await page.bringToFront();
    report.render = await page.evaluate(() => window.runRenderBenchmark({ fixture: 'colored', packed: true }));
  }
  if (errors.length || report.pixels.webglError || report.lod.webglError || report.render?.webglError
    || report.baseline?.webglError || report.baseline?.awayDrawCalls || report.render?.awayDrawCalls || report.workers.some(r => r.webglError)) {
    throw new Error('Browser correctness checks failed; see the saved report.');
  }
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  // Preserve completed checks even when compositor/RAF scheduling prevents an
  // FPS measurement. Never replace missing frames with timer-derived FPS.
  await mkdir('output/playwright', { recursive: true });
  const path = `output/playwright/voxel-benchmark-${name}${checksOnly ? '-checks' : ''}.json`;
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Saved ${path}`);
}
