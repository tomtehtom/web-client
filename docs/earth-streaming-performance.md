# Real Earth streaming and textured rendering — September 5, 2026

These measurements use the actual web client, real streamed Google-origin GLBs
through the configured `edu.voxelearth.org` service, and the San Francisco view
at 37.7749, -122.4194. Tile requests were not mocked. The machine uses an NVIDIA
RTX 3090; these are local measurements, not promises for integrated/mobile GPUs.

## What changed

- Minecraft preview uses the same packed geometry as colored preview. A shared
  5-6-5 sRGB → block-rectangle lookup uses the existing OKLab palette and brightness
  bias. The fragment shader repeats the selected atlas texture once per voxel.
  Toggling textures starts **zero voxelization jobs** and retains chunk/tile culling.
  The deterministic lookup uses bin centers; blocks near color-selection boundaries
  can differ from the old first-sample-per-bin matcher. Export keeps its grid/atlas path.
- Worker output batches chunks within each source tile. A batched quad uses its
  existing 8-byte descriptor plus a 4-byte chunk coordinate. Face-color rectangles
  are concatenated exactly, with a maximum 2048×2048 atlas per batch. Source-tile
  bounds preserve culling; finer chunk culling is traded for much fewer draw calls.
- Exact-color previews skip unused vertex-color palette sampling and k-means.
  Bilinear sampling uses shared byte-to-linear lookup tables and a reusable output,
  preserving premultiplied-alpha interpolation while removing repeated powers and
  temporary arrays. Normalized/interleaved GLTF attributes are decoded correctly
  before worker transfer.
- The development client uses a same-origin Vite proxy for the configured Earth
  service, which rejected localhost CORS. Root-relative and absolute child URLs
  retain the proxy prefix. Production endpoints and explicit Google API-key routing
  remain configured normally. Production hosting must provide valid CORS or its own
  reverse proxy. Transient network/500/502/503/504 tile failures get at most two retries;
  cancellation, authentication and rate limits do not enter that retry loop.

## Live Chrome results

Chrome 152.0.7977.76, hardware WebGL, default three-pixel LOD target. High-detail
tests use a 3840×2160 drawing buffer and resolution cap 256. Voxel counts below are
occupied voxels across visible source tiles; hidden voxel faces are not drawn.

| View | Before tile batching | After tile batching |
| --- | ---: | ---: |
| 4K, stationary textured view | 9.75 million voxels | 9.83 million voxels |
| Draw calls | 9,080 | 252 |
| Submitted triangles | 8.14 million | 9.47 million |
| Median frame interval | 33.2 ms (~30 FPS) | 16.7 ms (~60 FPS) |
| P95 frame interval | 50.1 ms | 17.1 ms |
| After moving camera | 13.53 million voxels | 13.39 million voxels |
| Draw calls after movement | 13,650 | 335 |
| Median / P95 after movement | 49.6 / 66.6 ms | 16.7 / 17.1 ms |

The batch tradeoff is visible: more triangles can be submitted because culling
operates at a coarser granularity, yet frame pacing improves substantially. The
live tile sets differ slightly because streaming/refinement and network responses
vary. These are comparable camera scenarios, not identical captured-frame GPU tests.
Frame intervals come from RAF; they are not asynchronous GPU timer measurements.

At 1600×1000, the same 99 tiles contain 250,075 voxels before and after the changes.
The old Minecraft path retains **527,928,864 bytes** of per-tile output; the new path
retains **3,699,484 bytes**, plus **4,734,976 bytes** of shared lookup/atlas payload.
Texture toggling adds no geometry and no build jobs. Driver allocations, source
GLBs and serialized source caches are additional memory.

After the 4K camera move, active output alone reaches about 170 MB. The 128 MiB
cache target evicts unused variants but protects visible active data and reports
the overage. This is deliberately not advertised as a hard VRAM limit.

Initial streaming/refinement still takes seconds: the 99-tile view was complete
by the 15-second sample in these cold runs. Network transfer, GLB decoding and
scheduling are separate from per-tile voxelization. One Chrome run had a transient
upstream connection reset; that motivated the bounded retry handling.

## Voxelization algorithm comparison

Eight actual streamed tiles, 5,117–6,088 source triangles each, resolution 128,
three repetitions per implementation with alternating order. Both workers receive
the same serialized sources. Batching is disabled only for this comparison so
descriptor and atlas bytes can be compared directly.

- Every sampled output was byte-identical: voxel counts, packed geometry and color
  atlas data all matched.
- Per-tile median improvements ranged from **1.10× to 2.13×**.
- Sum of per-tile median worker times: **283.4 → 182.5 ms**, or **1.55× faster**.
- Median across those per-tile medians: **33.9 → 19.65 ms**.

These isolate the sampler/palette optimization. They do not credit worker-speed
gains for removed export/UV work or for fewer rendering draw calls.

## Browser and correctness checks

The checks compare packed/batched color output against conventional geometry in
six axial views. A separate six-view comparison uses a patterned atlas against
ordinary repeated-texture geometry, checking UV orientation, repetition, atlas
bounds and color conversion. Chrome, Edge and Firefox report zero mismatches in
both checks, with geometry/texture counts returning to zero after disposal.
CPU tests cover 3,200 independent bilinear samples, alpha, transforms, normalized
and interleaved attributes, exact batch relocation, atlas-budget splitting and URLs.
Actual-map tests verify LOD reuse, texture toggling without rebuilds, cancellation
and disposal. Worker transport is checked through JS, WASM and WebGPU.

Firefox's default Windows automation run loaded all 99 real textured tiles but
subsequently stopped advancing frames; those stale frame samples are not a valid
continuing FPS result. Windows occlusion tracking is a documented Firefox behavior:
[Mozilla's occlusion implementation](https://bugzilla.mozilla.org/show_bug.cgi?id=1688997)
and [background rendering report](https://bugzilla.mozilla.org/show_bug.cgi?id=1759393).
The controlled rerun disables that tracking only in its disposable test profile;
the application and the user's browser preferences are not changed. Firefox
146.0.1 then held a median/P95 frame interval of **16.66/16.68 ms** at 3840×2160:
9.75 million occupied voxels with 248 draw calls, rising to 13.40 million with 335
draw calls after camera movement. All 756 GLBs and 273 JSON responses succeeded;
the run recorded no client/shader errors. These are foreground, controlled-profile
measurements. See `earth-firefox-unoccluded.json` for the full results. The harness
records frame age and drops stale frame metrics.

## Loading coverage follow-up

A subsequent Paris loading report exposed gaps that stationary FPS tests missed:
voxel mode disabled the entire source-imagery layer before replacement meshes
existed. Each loaded source tile now remains visible until its own nonempty voxel
mesh is attached. Empty or deliberately skipped tiny tiles retain source coverage.
The source renderer still controls parent/child selection and unloads.

The voxel queue retains waiting tiles and refills on worker completion, instead of
dropping deferred work until the next 300 ms sweep. It prioritizes tiles without a
voxel mesh, then distance, with a 2–4 ms main-thread dispatch budget per frame.
Packed reconstruction and attachment continue during camera interaction; distant
LOD reevaluation still waits for interaction to settle. Individual synchronous
serialization calls can exceed the dispatch budget.

`npm run test:earth-coverage` exercises the actual Paris preset, cold loading,
Minecraft mode and a real pointer drag, asserting that the camera moved. In Chrome,
2,171 sampled frames had zero **loaded visible tiles without a representation**.
Source coverage began at 0.49 seconds and the first voxel mesh at 9.42 seconds in
that run; full-scene latency still depends on network/refinement and worker startup.
Median/P95 frame intervals were 16.7/17.1 ms at 1600×1000. Two upstream tile requests
failed; the renderer retained loaded coverage. This check does not promise coverage
where no source data has arrived, nor does it prove pixel-perfect source-tile seams.
The report is `output/playwright/earth-coverage-chrome.json`, with loading, moving
and settled screenshots alongside it. `window.getVoxelCoverageStats()` exposes
the source fallback, voxel, uncovered, queued and running counts for diagnostics.

Firefox 146 also passed the pointer-drag test: 2,243 frames with zero uncovered
loaded tiles and 16.66/16.68 ms median/P95 intervals. Source coverage began at 0.46
seconds and voxels at 6.26 seconds. This uses the same disposable-profile Windows
occlusion setting described above; the app does not change browser preferences.

## Reproduce

```powershell
npm run test:mesher
npm run test:lod
npm run test:textures
npm run test:map-lod
npm run test:earth-coverage
npm run benchmark:webgpu

$env:EARTH_REPORT = 'earth-live'
$env:EARTH_HIGH_RES = '1'
npm run benchmark:earth

$env:VOXEL_BROWSER = 'firefox'
$env:EARTH_NO_OCCLUSION = '1' # disposable automation profile only
npm run benchmark:earth
```

Reports and screenshots are under `output/playwright/` and are ignored by Git.
The optional `EARTH_COMPARE_WORKER=1` comparison requires the saved pre-change
worker at `output/playwright/voxelizer-baseline.worker.js`; the ordinary live test
does not depend on that local snapshot. Synthetic checks need no map credentials;
live tests require the configured tile service to be available. The test browser
and temporary Vite server close when the runner finishes.

GPU-resident rasterization/meshing, global VRAM admission control, smooth distant
texture filtering and crack-free transitions between independently bounded source
tiles remain future work. They are not prerequisites for the measured packed path.
