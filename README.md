# Voxel Earth — Web Client
**VoxelEarth monorepo with consistent versions:** https://github.com/ryanhlewis/VoxelEarth

A lightweight web client that fetches Google Photorealistic **3D Tiles**, normalizes/rotates them, and can hand them off to the Voxel Earth voxelization pipeline for experiments and demos.

> Based on (and thanks to) **Omar Shehata’s** work in **google-earth-as-gltf**, which demonstrates fetching 3D Tiles and normalizing them into viewable glTF.

## Run locally
```bash
npm install
npm run dev        # starts the dev server
# optional production build
npm run build
npm run preview
```

## Voxel performance

The worker meshes occupied chunks with neighbor halos and hidden-face removal.
The map preview uses 8-byte instanced quads and per-face color atlases for all
voxelization methods. Faces merge across color changes without losing voxel
color detail. Minecraft preview uses the same geometry with a shared GPU block
lookup and repeating atlas textures. Single Scene uses the same packed preview,
retains a sparse export grid, and builds conventional GLB geometry only on export.
Worker output batches chunks per source tile to reduce draw calls.
Visible map tiles now adjust detail with distance, retain the current mesh during
rebuilds, and reuse up to three cached variants per tile. A 128 MiB payload target
evicts unused levels; visible active meshes are protected. Inspect actual usage
and cache hits with `window.getVoxelLodStats()`.

```bash
npm run test:mesher
npm run test:lod
npm run test:textures
npm run test:map-lod # actual map lifecycle with synthetic tiles; no credentials
npm run test:export
npm run test:single-scene # mobile layout, packed preview and export round-trips
npm run benchmark:voxel
npm run benchmark:mesher
npm run benchmark:webgpu # opens Chrome; checks workers and measures 4K rendering
npm run benchmark:earth # actual client and live streaming service
```

For a credential-free 4K rendering test, run the dev server and open
`/scripts/voxel-render-benchmark.html`. The page reports frame pacing, GPU timing
when supported, submitted triangles, draw calls, descriptor bytes and atlas bytes.
It compares conventional meshes against packed rendering on detailed color data.
`window.runWorkerSmoke()` checks textured JS/WASM/WebGPU worker output, and
`window.runPackedPixelCheck()` compares all six face directions with the reference
renderer and verifies GPU resource cleanup.
`window.runLodWorkerCheck()` checks cached swaps, warm workers and cancellation.
Set `VOXEL_CHECKS_ONLY=1` for CPU/correctness checks without frame measurements;
set `VOXEL_BROWSER=firefox` or `msedge` to select another browser.

See [the performance investigation](docs/voxel-performance.md) for measurements,
limitations and the next steps toward high-density terrain rendering.
See [the real Earth streaming measurements](docs/earth-streaming-performance.md)
for textured mode, 4K camera movement, worker comparisons and browser limitations.
See [Single Scene export and mobile measurements](docs/single-scene-performance.md)
for worker exports, texture fidelity, touch controls and memory limits.

## Useful files & dirs
- `src/index.js` — fetch tiles (via loaders.gl), set up traversal.
- `src/Viewer.js` — normalize tiles from ECEF to an origin-centered frame for viewing.
- `simple-node-example/` — minimal example fetching tiles for a region.
- `public/` — static assets.

## Where this fits
Use this to visually explore tiles/regions and parameters (zoom, SSE) before running a full voxelization flow in the monorepo.

## Acknowledgements
- **Omar Shehata** — google-earth-as-gltf (viewer + examples).
- **Cesium / loaders.gl** — 3D Tiles traversal & decoding ecosystem.
- **Google** — Photorealistic 3D Tiles.
- **NASA AMMOS** — [3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS), a Three.js-based **3D Tiles** renderer used across planetary operations.
