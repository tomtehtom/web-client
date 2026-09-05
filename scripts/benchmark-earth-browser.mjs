import { createServer } from 'vite';
import { chromium, firefox } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

// No tile interception: runs the real client's configured streaming endpoint.
const name = process.env.VOXEL_BROWSER || 'chrome';
const label = process.env.EARTH_REPORT || 'earth';
const noOcclusion = process.env.EARTH_NO_OCCLUSION === '1';
const report = { browser: name, noOcclusion, capturedAt: new Date().toISOString(), responses: {}, errors: [], samples: [] };
let server, browser;
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false } }); await server.listen();
  browser = await (name === 'firefox' ? firefox : chromium).launch({ headless: false,
    ...(name === 'firefox' ? (noOcclusion ? { firefoxUserPrefs: { 'widget.windows.window_occlusion_tracking.enabled': false } } : {}) : { channel: name }) });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(20000);
  // Never log query strings/session credentials from network or error messages.
  const redact = text => text.replace(/\?[^\s)'"<>]+/g, '?[redacted]').replace(/https?:\/\/[^\s)'"<>]+/g, raw => { try { const url = new URL(raw); return url.origin + url.pathname; } catch { return '[url]'; } });
  page.on('pageerror', error => report.errors.push(redact(error.message)));
  report.consoleErrors = []; report.failedRequests = [];
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') report.consoleErrors.push(redact(message.text()));
    if (/THREE.WebGLProgram|INVALID_OPERATION|shader error/i.test(message.text())) report.errors.push(redact(message.text()));
  });
  page.on('requestfailed', request => report.failedRequests.push({ url: redact(request.url()), error: request.failure()?.errorText }));
  page.on('response', response => {
    const url = new URL(response.url());
    if (!url.pathname.includes('/3dtiles/') && !/\.(b3dm|glb|gltf)$/.test(url.pathname)) return;
    const key = `${url.hostname}:${response.status()}:${url.pathname.split('.').pop()}`;
    report.responses[key] = (report.responses[key] || 0) + 1;
  });
  await page.addInitScript(() => {
    localStorage.setItem('coords', '37.7749,-122.4194');
    window.earthTiming = { frames: [], longTasks: [] };
    let previous;
    const tick = time => {
      if (previous) { window.earthTiming.frames.push({ time, ms: time - previous }); if (window.earthTiming.frames.length > 600) window.earthTiming.frames.shift(); }
      previous = time; requestAnimationFrame(tick);
      window.earthTiming.lastFrame = time;
    }; requestAnimationFrame(tick);
    try { new PerformanceObserver(list => { for (const entry of list.getEntries()) window.earthTiming.longTasks.push(entry.duration); }).observe({ type: 'longtask', buffered: true }); } catch {}
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.tiles && window.getVoxelLodStats, null, { polling: 100 });
  report.endpoint = await page.evaluate(() => { const u = new URL(window.tiles._rootUrl); return u.origin + u.pathname; });
  const sample = async stage => {
    const value = await page.evaluate(stage => {
      const visible = window.tiles.group.children.filter(tile => tile.userData.rendererVisible !== false);
      const voxels = visible.filter(tile => tile._voxelizer);
      const times = window.earthTiming.frames.filter(frame => frame.time > performance.now() - 10000).map(frame => frame.ms).sort((a, b) => a - b);
      const frameAgeMs = performance.now() - (window.earthTiming.lastFrame ?? 0);
      return { stage, rootLoaded: !!window.tiles.root, streaming: window.tiles.stats, render: window.getVoxelRenderStats?.(), visibleTiles: visible.length, voxelTiles: voxels.length, cache: window.getVoxelLodStats(),
        voxelCount: voxels.reduce((sum, tile) => sum + tile._voxelizer.voxelCount, 0),
        texturedTiles: voxels.filter(tile => tile._mcApplied).length,
        frameAgeMs, visibility: document.visibilityState, focused: document.hasFocus(),
        frameP50: frameAgeMs < 1000 ? times[Math.floor(times.length * 0.5)] ?? null : null, frameP95: frameAgeMs < 1000 ? times[Math.floor(times.length * 0.95)] ?? null : null,
        longTasks: window.earthTiming.longTasks.length, maxLongTask: Math.max(0, ...window.earthTiming.longTasks),
        tileStats: voxels.slice(0, 20).map(tile => ({ resolution: tile._voxResolution, ...tile._voxelizer.stats })),
      };
    }, stage);
    report.samples.push(value); console.log(JSON.stringify({ ...value, tileStats: undefined })); return value;
  };
  for (let i = 0; i < 8; i++) { await page.waitForTimeout(5000); await sample(`stream-${i}`); }
  if (!report.samples.at(-1).voxelTiles) throw new Error('No real streamed voxel tiles became visible.');
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: `output/playwright/${label}-color.png`, style: '#policy-banner { visibility:hidden !important; }' });
  await page.evaluate(() => {
    window.earthTiming.frames = []; window.earthTiming.longTasks = [];
    const toggle = document.querySelector('#toggle-mc'); toggle.checked = true; toggle.dispatchEvent(new Event('change'));
  });
  for (let i = 0; i < 6; i++) { await page.waitForTimeout(5000); await sample(`textured-${i}`); }
  if (!report.samples.at(-1).texturedTiles) throw new Error('Textured mode did not attach any real streamed tiles.');
  await page.screenshot({ path: `output/playwright/${label}-textured.png`, style: '#policy-banner { visibility:hidden !important; }' });
  if (process.env.EARTH_HIGH_RES === '1') {
    await page.setViewportSize({ width: 3840, height: 2160 });
    await page.evaluate(() => {
      const input = document.querySelector('#res-fine'); input.value = '256'; input.dispatchEvent(new Event('change'));
      window.earthTiming.frames = []; window.earthTiming.longTasks = [];
    });
    for (let i = 0; i < 8; i++) { await page.waitForTimeout(5000); await sample(`4k-textured-${i}`); }
    await page.screenshot({ path: `output/playwright/${label}-4k-textured.png`, style: '#policy-banner { visibility:hidden !important; }' });
    // Move the real streaming camera: this exercises refinement and cancellation,
    // including newly visible tiles, rather than a frozen scene benchmark.
    await page.evaluate(() => { const camera = window.tiles.cameras[0]; camera.position.x += 200; camera.position.z += 120; });
    for (let i = 0; i < 4; i++) { await page.waitForTimeout(5000); await sample(`moving-${i}`); }
  }
  if (process.env.EARTH_COMPARE_WORKER === '1') {
    report.algorithm = await page.evaluate(async () => {
      const { serializeModel } = await import('/src/voxelize-model.js');
      const sources = window.tiles.group.children.filter(tile => tile._voxelizer).sort((a, b) => b._voxelizer.stats.triangleCount - a._voxelizer.stats.triangleCount).slice(0, 8);
      const workers = [new Worker('/output/playwright/voxelizer-baseline.worker.js', { type: 'module' }), new Worker('/src/voxelizer.worker.js', { type: 'module' })];
      const run = (worker, payload) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker comparison timed out')), 30000);
        worker.onmessage = event => { clearTimeout(timer); event.data.status === 'error' ? reject(new Error(event.data.message)) : resolve(event.data.result); };
        worker.onerror = error => { clearTimeout(timer); reject(new Error(error.message)); };
        worker.postMessage({ modelData: payload, resolution: 128, method: '2.5d-scan', needGrid: false, renderMode: 'packed', batchPacked: false });
      });
      const equal = (a, b) => a?.length === b?.length && (!a || a.every((v, i) => v === b[i]));
      const results = [];
      try {
        for (const source of sources) {
          const payload = serializeModel(source);
          const timings = [[], []];
          for (let repeat = 0; repeat < 3; repeat++) {
            // Alternate order to reduce systematic warm-up/thermal bias.
            const outputs = [];
            for (const w of repeat % 2 ? [1, 0] : [0, 1]) {
              outputs[w] = await run(workers[w], payload);
              timings[w].push(outputs[w].stats);
            }
            const [a, b] = outputs;
            if (a.voxelCount !== b.voxelCount || a.packedChunks.length !== b.packedChunks.length) throw new Error('Voxel coverage changed on a real tile');
            for (let i = 0; i < a.packedChunks.length; i++) {
              if (!equal(a.packedChunks[i].quads, b.packedChunks[i].quads) || !equal(a.packedChunks[i].atlas, b.packedChunks[i].atlas)) throw new Error('Packed geometry/color bytes changed on a real tile');
            }
          }
          results.push({ triangles: source._voxelizer.stats.triangleCount, baseline: timings[0], optimized: timings[1], byteIdentical: true });
        }
        return results;
      } finally { workers.forEach(worker => worker.terminate()); }
    });
  }
  if (report.errors.length) throw new Error('Client/shader errors occurred; see report');
  report.version = browser.version();
} catch (error) { report.failure = error.message.replace(/\?[^\s)]+/g, '?[redacted]'); process.exitCode = 1; }
finally {
  await browser?.close(); await server?.close();
  await mkdir('output/playwright', { recursive: true });
  await writeFile(`output/playwright/${label}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ saved: `output/playwright/${label}.json`, responses: report.responses, failure: report.failure, errors: report.errors }));
}
