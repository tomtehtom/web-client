import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import nbt from 'prismarine-nbt';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { BLOCK_REGISTRY_COUNT, MINECRAFT_DATA_VERSION } from '../src/minecraft-version.js';

let server, browser;
const report = { errors: [], captures: [] };
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false } }); await server.listen();
  browser = await chromium.launch({ headless: true, channel: process.env.VOXEL_BROWSER || 'msedge',
    args: process.env.VOXEL_SOFTWARE_GL ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (/THREE.WebGLProgram|shader error|INVALID_OPERATION/i.test(message.text())) report.errors.push(message.text()); });
  await page.route('**/v1/3dtiles/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    asset: { version: '1.1' }, geometricError: 0,
    root: { boundingVolume: { sphere: [6378137, 0, 0, 1] }, geometricError: 0, children: [] },
  }) }));
  await page.goto(server.resolvedUrls.local[0]);
  await page.addStyleTag({ content: '#policy-banner { visibility:hidden !important; }' });
  await page.waitForFunction(() => window.tiles && window.getVoxelLodStats);
  await page.locator('#model-picker-btn').click();
  await page.locator('[data-model="single-scene"]').click();
  await page.waitForFunction(() => !!window.singleSceneViewer);
  assert.equal(await page.locator('#minecraft-block-palette #toggle-mc').count(), 1);
  assert.equal(await page.locator('#map-minecraft-textures-slot #toggle-mc').count(), 0);
  assert.equal(await page.locator('#single-scene-scale-mode').inputValue(), 'metric');
  assert.equal(await page.locator('#single-scene-meters-per-block').inputValue(), '1');
  assert.ok(await page.locator('#single-scene-res-input').isDisabled());
  assert.ok(await page.locator('#single-scene-export-btn').isDisabled());
  await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const { GLTFExporter } = await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(8, 6, 4), new THREE.MeshBasicMaterial({ color: 0x7b858c }));
    mesh.position.set(6378137, 0, 0); scene.add(mesh);
    const data = await new GLTFExporter().parseAsync(scene, { binary: true });
    const url = URL.createObjectURL(new Blob([data]));
    await window.singleSceneViewer.loadGLTFTiles([url]); URL.revokeObjectURL(url);
    document.querySelector('#single-scene-meters-per-block').dispatchEvent(new Event('change'));
  });
  const ready = () => page.waitForFunction(() => window.singleSceneViewer.voxelSettingsCurrent === true);
  const measure = () => page.evaluate(() => {
    const viewer = window.singleSceneViewer, grid = viewer.voxelizer._voxelGrid;
    return { metersPerBlock: grid.unit.x * viewer.metersPerViewerUnit, size: grid.gridSize,
      metadata: grid.exportMetadata, sparse: !!grid.sparse, voxels: viewer.voxelizer.voxelCount };
  });
  await ready();
  const zero = await measure(); report.captures.push(zero);
  assert.ok(await page.locator('#res-fine').isDisabled());
  assert.equal(await page.locator('#single-scene-colour-matching').inputValue(), 'accurate');
  await page.evaluate(() => {
    window.settingsSource = window.singleSceneViewer.tilesContainer;
    const method = document.querySelector('input[name="voxel-method"][value="3d-sat"]'); method.checked = true; method.dispatchEvent(new Event('change'));
  });
  await ready();
  assert.equal(await page.evaluate(() => window.singleSceneViewer.voxelizer.stats.method), '3d-sat');
  assert.equal(await page.evaluate(() => window.singleSceneViewer.tilesContainer === window.settingsSource), true);
  assert.ok(Math.abs((await measure()).metersPerBlock - 1) < 1e-10);
  await page.evaluate(() => {
    const method = document.querySelector('input[name="voxel-method"][value="2.5d-scan"]'); method.checked = true; method.dispatchEvent(new Event('change'));
  });
  await ready();
  assert.ok(await page.evaluate(() => document.querySelector('#single-scene-log').textContent.includes('Voxelizing triangles')));
  assert.equal(await page.locator('#single-scene-sse-value').inputValue(), '1');
  await page.locator('#single-scene-max-detail').check();
  assert.ok(await page.locator('#single-scene-sse-value').isDisabled());
  await page.locator('#single-scene-max-detail').uncheck();
  await page.evaluate(() => {
    const toggle = document.querySelector('#toggle-mc'); toggle.checked = true; toggle.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => window.singleSceneViewer.voxelMeshes[0].userData.__mcApplied);
  await page.locator('#single-scene-colour-matching').selectOption('fast');
  await page.waitForFunction(() => document.querySelector('#single-scene-palette-status').textContent.includes('fast matching'));
  assert.equal(await page.evaluate(() => window.singleSceneViewer.voxelMeshes[0].children[0].material.uniforms.accurateMatching.value), false);
  await page.locator('#single-scene-colour-matching').selectOption('accurate');
  await page.waitForFunction(() => document.querySelector('#single-scene-palette-status').textContent.includes('accurate matching'));
  assert.equal(await page.evaluate(() => window.singleSceneViewer.voxelMeshes[0].children[0].material.uniforms.accurateMatching.value), true);
  const beforePalette = await page.evaluate(() => { window.paletteMesh = window.singleSceneViewer.voxelMeshes[0]; return window.singleSceneViewer.voxelizer.voxelCount; });
  await page.locator('[data-block-palette="glazed"]').check();
  await page.waitForFunction(() => document.querySelector('#single-scene-palette-status').textContent.startsWith('65 blocks'));
  report.palette = await page.evaluate(async () => {
    const { BLOCKS, getBlockPaletteKey } = await import('/src/assignToBlocksForGLB.js');
    return { names: BLOCKS.map(block => block.name), sameMesh: window.singleSceneViewer.voxelMeshes[0] === window.paletteMesh,
      voxels: window.singleSceneViewer.voxelizer.voxelCount, saved: JSON.parse(localStorage.getItem('minecraftBlockPalette')),
      previewUpdated: window.singleSceneViewer._blockResources.paletteKey === getBlockPaletteKey() };
  });
  assert.equal(report.palette.names.length, 65);
  assert.ok(report.palette.sameMesh && report.palette.voxels === beforePalette && report.palette.saved.glazed);
  assert.ok(report.palette.previewUpdated, 'Minecraft preview must use the updated palette lookup');
  assert.ok(!report.palette.names.some(name => /concrete_powder|^sand$|^gravel$/.test(name)));
  await page.locator('[data-block-palette="glazed"]').uncheck();
  await page.waitForFunction(() => document.querySelector('#single-scene-palette-status').textContent.startsWith('49 blocks'));
  await page.evaluate(() => {
    const toggle = document.querySelector('#toggle-mc'); toggle.checked = false; toggle.dispatchEvent(new Event('change'));
  });
  await mkdir('output/playwright', { recursive: true });
  const fullDownload = page.waitForEvent('download');
  await page.locator('#palette-export-all').click();
  await (await fullDownload).saveAs('output/playwright/full-block-list.json');
  const fullList = JSON.parse(await readFile('output/playwright/full-block-list.json', 'utf8'));
  assert.equal(fullList.blocks.length, BLOCK_REGISTRY_COUNT);
  assert.equal(fullList.blocks.filter(block => block.enabled).length, 49);
  const importPalette = buffer => page.locator('#palette-import-file').setInputFiles({ name: 'palette.json', mimeType: 'application/json', buffer: Buffer.from(buffer) });
  await importPalette(JSON.stringify(['minecraft:white_wool', 'red_concrete', 'stone', 'sand', 'made_up_block']));
  await page.waitForFunction(() => document.querySelector('#palette-file-status').textContent.startsWith('Imported 3 blocks. 2'));
  assert.ok(await page.locator('[data-block-palette="wool"]').isDisabled());
  const customState = await page.evaluate(async () => {
    const { BLOCKS } = await import('/src/assignToBlocksForGLB.js');
    return { names: BLOCKS.map(block => block.name).sort(), sameMesh: window.singleSceneViewer.voxelMeshes[0] === window.paletteMesh };
  });
  assert.deepEqual(customState.names, ['red_concrete', 'stone', 'white_wool']); assert.ok(customState.sameMesh);
  await importPalette('{bad json');
  await page.waitForFunction(() => document.querySelector('#palette-file-status').textContent.startsWith('Import failed: Invalid palette JSON'));
  const selectedDownload = page.waitForEvent('download');
  await page.locator('#palette-export-selected').click();
  await (await selectedDownload).saveAs('output/playwright/selected-blocks.json');
  assert.deepEqual(JSON.parse(await readFile('output/playwright/selected-blocks.json', 'utf8')).sort(), ['minecraft:red_concrete', 'minecraft:stone', 'minecraft:white_wool']);
  await importPalette(JSON.stringify(fullList));
  await page.waitForFunction(() => document.querySelector('#palette-file-status').textContent.startsWith('Imported 49 blocks.'));
  await page.locator('#palette-reset').click();
  await page.waitForFunction(() => document.querySelector('#single-scene-palette-status').textContent.startsWith('49 blocks'));
  assert.ok(await page.locator('[data-block-palette="wool"]').isEnabled());
  assert.equal(await page.evaluate(() => localStorage.getItem('minecraftCustomBlocks')), null);
  await page.locator('#palette-all-solids').click();
  await page.waitForFunction(() => document.querySelector('#palette-file-status').textContent.startsWith('Using all 369 opaque solid blocks'));
  const balancedGrass = await page.evaluate(async () => (await import('/src/assignToBlocksForGLB.js')).BLOCKS.find(block => block.name === 'grass_block').rgb);
  await page.locator('#single-scene-colour-profile').selectOption('top');
  await page.waitForFunction(() => document.querySelector('#single-scene-palette-status').textContent.startsWith('369 blocks'));
  const terrainGrass = await page.evaluate(async () => (await import('/src/assignToBlocksForGLB.js')).BLOCKS.find(block => block.name === 'grass_block').rgb);
  assert.ok(terrainGrass.g > balancedGrass.g);
  assert.equal(await page.evaluate(() => window.singleSceneViewer.voxelMeshes[0] === window.paletteMesh), true);
  await page.locator('#single-scene-colour-profile').selectOption('balanced');
  await page.waitForFunction(() => document.querySelector('#single-scene-palette-status').textContent.startsWith('369 blocks'));
  await page.locator('#palette-reset').click();
  await page.waitForFunction(() => document.querySelector('#single-scene-palette-status').textContent.startsWith('49 blocks'));
  report.paletteFiles = { registryBlocks: fullList.blocks.length, roundTrip: true, customState, malformedKeptPalette: true };
  assert.ok(Math.abs(zero.metersPerBlock - 1) < 1e-10);
  assert.ok(zero.sparse);
  // ECEF X is local up; Y is east; Z is north at the equator/prime meridian.
  assert.deepEqual(zero.size, { x: 6, y: 8, z: 4 });
  await page.locator('#single-scene-rot-value').fill('90');
  await page.locator('#single-scene-rot-value').dispatchEvent('change');
  await ready();
  const rotated = await measure(); report.captures.push(rotated);
  assert.equal(rotated.metadata.rotationDegrees, 90);
  assert.ok(Math.abs(rotated.metersPerBlock - 1) < 1e-10);
  assert.deepEqual(rotated.size, { x: 4, y: 8, z: 6 });
  await page.locator('#single-scene-meters-per-block').fill('2');
  await page.locator('#single-scene-meters-per-block').dispatchEvent('change');
  await ready();
  const coarse = await measure(); report.captures.push(coarse);
  assert.ok(Math.abs(coarse.metersPerBlock - 2) < 1e-10);
  assert.deepEqual(coarse.size, { x: 2, y: 4, z: 3 });
  await page.locator('#single-scene-radius-value').fill('5000');
  await page.locator('#single-scene-radius-value').dispatchEvent('change');
  assert.equal(await page.locator('#single-scene-radius').inputValue(), '5000');
  // The only loaded geometry is our own procedural box, so both confirmations apply.
  await page.locator('#single-scene-confirm-no-photoreal').check();
  await page.locator('#single-scene-confirm-rights').check();
  assert.equal(await page.locator('#single-scene-export-format').inputValue(), 'schem');
  const downloading = page.waitForEvent('download');
  await page.locator('#single-scene-export-btn').click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), 'structure.schem');
  await mkdir('output/playwright', { recursive: true });
  await download.saveAs('output/playwright/metric-scene.schem');
  const downloadedSchematic = nbt.simplify((await nbt.parse(await readFile('output/playwright/metric-scene.schem'))).parsed);
  assert.equal(downloadedSchematic.DataVersion, MINECRAFT_DATA_VERSION);
  assert.deepEqual([downloadedSchematic.Width, downloadedSchematic.Height, downloadedSchematic.Length], [2, 4, 3]);
  assert.equal(JSON.parse(downloadedSchematic.Metadata.VoxelEarth).metersPerBlock, 2);
  report.largeCombined = await page.evaluate(async () => {
    const large = { gridSize: { x: 1000, y: 100, z: 1000 },
      sparse: { indices: new Float64Array([0, 99_999_999]), colors: new Uint32Array([0xff808080, 0xff808080]) } };
    const result = await window.singleSceneViewer.exportSession.run(large, 'schem');
    return { bytes: result.fileParts.reduce((sum, part) => sum + part.byteLength, 0), gzip: [...result.fileParts[0].slice(0, 2)] };
  });
  assert.ok(report.largeCombined.bytes < 200000);
  assert.deepEqual(report.largeCombined.gzip, [31, 139]);
  await page.locator('#single-scene-export-format').selectOption('schem-zip');
  const downloadingZip = page.waitForEvent('download');
  await page.locator('#single-scene-export-btn').click();
  await (await downloadingZip).saveAs('output/playwright/metric-scene.zip');
  report.zip = await page.evaluate(async () => {
    const v = window.singleSceneViewer;
    const result = await v.exportSession.run(v.voxelizer._voxelGrid, 'schem-zip');
    return { manifest: result.manifest, bytes: result.archiveParts.reduce((sum, part) => sum + part.byteLength, 0) };
  });
  assert.equal(report.zip.manifest.metersPerBlock, 2);
  assert.equal(report.zip.manifest.rotationDegrees, 90);
  assert.ok(report.zip.bytes > 1000);
  await page.screenshot({ path: 'output/playwright/metric-scene-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/playwright/metric-scene-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => {
    const toggle = document.querySelector('#toggle-vox'); toggle.checked = false; toggle.dispatchEvent(new Event('change'));
  });
  await page.locator('#single-scene-meters-per-block').fill('4');
  await page.locator('#single-scene-meters-per-block').dispatchEvent('change');
  assert.equal(await page.evaluate(() => window.singleSceneViewer.voxelSettingsCurrent), false);
  await page.evaluate(() => {
    const toggle = document.querySelector('#toggle-vox'); toggle.checked = true; toggle.dispatchEvent(new Event('change'));
  });
  await ready();
  assert.ok(Math.abs((await measure()).metersPerBlock - 4) < 1e-10, 'Showing voxels again must rebuild stale scale settings');
  await page.locator('#single-scene-scale-mode').selectOption('density');
  await ready();
  assert.ok(await page.locator('#single-scene-res-input').isEnabled());
  assert.ok(await page.locator('#single-scene-meters-per-block').isDisabled());
  assert.deepEqual(report.errors, []);
} catch (error) { report.failure = error.stack; process.exitCode = 1; }
finally {
  await browser?.close(); await server?.close();
  await mkdir('output/playwright', { recursive: true });
  await writeFile('output/playwright/metric-scene.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
