# Voxel rendering investigation — 2026-09-05

Millions of stored voxels are practical when the renderer submits a small visible
surface. Millions of isolated, visible cubes are a fundamentally harder workload.
Voxelization throughput, mesh construction, upload latency, draw submission and
GPU shading need separate budgets. Switching the rasterizer to WebGPU alone does
not solve all five.

## Changes implemented

The subsequent [real Earth streaming pass](earth-streaming-performance.md) extends
this path to Minecraft textures, batches chunks per tile and measures millions of
voxels in the actual streaming client. Earlier fixture numbers below remain labeled
as historical measurements.

- Added persistent distance-based map LOD, hysteresis and three cached variants
  per tile. Swaps retain the previous mesh until its replacement is attached.
  A 128 MiB retained-payload target evicts inactive/hidden representations while
  protecting visible active meshes; this is not a hard GPU-memory limit.
- JS, WASM and WebGPU jobs share a lazy, reusable pool of up to four workers.
  Sequential builds use one warm worker. Cancellation now rejects queued and
  running jobs, prevents late reconstruction from leaking output, and discards
  stale tile generations. Retargeting invalidates cached source transforms,
  including hidden tiles detached by the source renderer.
- Replaced the worker's coordinate-lookup-heavy greedy sweep with a reusable
  padded chunk array and typed-array output. Only occupied chunks and their
  occupied extents are swept. Six neighbor slabs supply occupancy; each chunk
  emits only faces belonging to its own voxels. This also removes duplicate
  faces at occupied/empty chunk boundaries.
- The map now requests `renderMode: 'packed'` for colored and Minecraft previews across
  all three voxelization methods. It uses 8-byte instanced quads, merges across
  color changes and samples varying voxel colors from per-chunk face atlases.
  Uniform-color rectangles carry RGB directly and allocate no atlas texels.
  Tile batches add a 4-byte chunk coordinate to each quad.
  Conventional `surface` and legacy `instances` APIs remain available.
- Palette meshes still support the existing Minecraft/export path. Preview-only
  jobs no longer retain the separate float color/alpha/count store. Export jobs
  still retain it, with tests checking that export and preview geometry agree.
- Geometry reconstruction yields after a 4 ms CPU budget instead of after every
  two chunks. A tile with 128 tiny meshes previously incurred roughly 63 frame
  waits, independent of how little work reconstruction required.
- Reuse a material within each reconstructed group and disable automatic local
  matrix recomputation on static chunk meshes. Restore single-scene frustum
  culling after its bounds are recomputed. Remove stale, camera-dependent custom
  render orders; use Three.js's normal opaque ordering.
- Corrected worker statistics so end-to-end `totalMs` is no longer overwritten
  by worker-only time. `workerComputeMs` and `stats.mesh` expose worker time,
  visible unit faces, merged quads, triangles, occupied/renderable chunks and
  geometry bytes.
- Corrected WebGPU raster bounds. Triangles on the positive grid boundary were
  skipped; triangles outside a tile could produce invalid unsigned limits.
  The closed-box browser test now produces 96,776 voxels in JS, WASM and WebGPU.
- Added a production-buildable, credential-free browser benchmark and repaired
  the Vite entry that referenced a missing benchmark page.

## Packed renderer results (second pass)

The detailed-color fixture assigns different RGB bytes throughout the same
2,386,051-voxel rolling terrain. The shape and voxel colors are identical in
both representations. Node runs discard a warm-up and take a median of three.

| Fixture | Conventional bytes | Packed descriptors + atlas | Triangle count before → after | Mesh time before → after |
| --- | ---: | ---: | ---: | ---: |
| Solid 128³ | 7,296 | 768 | 192 → 192 | 89.5 → 54.2 ms |
| Two-color terrain | 1,562,712 | 212,416 | 41,124 → 40,756 | 72.1 → 72.1 ms |
| Detailed-color terrain | 14,923,360 | 928,752 | 392,720 → 40,756 | 106.8 → 72.8 ms |
| Isolated-cell stress case | 553,648,128 | 50,331,648 | 12,582,912 → 12,582,912 | 847.3 → 384.6 ms |

This is 16.1× less output memory and 9.6× fewer triangles for detailed-color
terrain. These byte counts include atlas row padding but exclude driver objects,
framebuffers, source voxel data, and 60 bytes of base geometry per packed chunk.
The isolated-cell case still needs 12.6 million triangles; compression is not LOD.

Chrome/Edge comparisons remained refresh-limited around 60 FPS at 4K. GPU timer
results varied and did not show a consistent GPU-time speedup at this workload:
for example, one Chrome run measured 2.05 ms conventional and 3.08 ms packed.
Reduced memory, upload volume and triangle count are the demonstrated wins;
packed decoding and atlas sampling have their own shader cost. This change is
not a claim of a 16× frame-rate improvement.

An earlier Firefox 155 CLI automation session reported roughly 3.4 seconds
conventional versus 3.1 seconds packed for the mesher. Fresh project-runner
diagnostics did **not reproduce** that result: Firefox 146 packed timings were
105–134 ms and Firefox 155 timings were 102–179 ms over direct/deferred runs.
A later full correctness run measured 156–186 ms on Firefox 146. The difference
between debugger-evaluated and deferred execution was small; the earlier
multi-second result is not explained by this experiment, and is not evidence of
a fixed application defect. Production worker meshing also ran in roughly
114–121 ms on the textured-box fixture in those Firefox diagnostics.

Firefox frame callbacks still stalled in a fresh headed 4K run; no new FPS
claim is made for that failed run. The harness times out, preserves completed
checks in its report and exits unsuccessfully. `VOXEL_CHECKS_ONLY=1` runs useful
CPU/worker/pixel checks independently of frame scheduling. The earlier Firefox
155 textured WebGPU request fell back to JS; Firefox 146 diagnostics exercised
actual WebGPU successfully. Availability/performance must be checked per session.

The browser pixel check renders a textured, partially hollow shape spanning a
chunk boundary from all six axial directions. Chrome, Edge and Firefox produced
zero pixel differences against conventional meshes. Texture/geometry counts
returned to their pre-test values after disposal. Actual worker jobs transfer
both descriptors and atlas buffers, render 96,776 textured box voxels, and report
WebGPU fallback explicitly when unavailable. Production build and Node oracle
tests also pass.

Format: word 0 contains three 6-bit chunk-local coordinates, two 5-bit extents
stored as length-minus-one, a 3-bit direction and a 1-bit atlas flag. Word 1 is
RGB24 or a linear atlas offset. Rectangles are stored consecutively; integer
`texelFetch` converts the linear texel index into a 2D coordinate. Rectangles can
cross texture rows without padding or color bleeding. Shader clamping handles
interpolated rectangle edges. No mipmaps are generated; distant color filtering
is still a future LOD/rendering decision.

The packed shader targets the existing WebGL2 map renderer. API requests that
need the voxel grid use conventional palette meshes; explicit Three.js
WebGPURenderer callers fall back to conventional exact-color surfaces. Packed
meshes are preview data, not a general GLTF-export or CPU-raycast representation.
Minecraft preview toggles now update shared shader textures without rebuilding.
Single-scene/export atlas operations retain their conventional grid workflow.

## First-pass measured results

Measurements are local synthetic results, not a claim about all map regions or
GPUs. Node figures below are the existing benchmark's warmed averages; the
before and after runs used this same workspace and machine.

| Existing fixture | Before | After | Improvement |
| --- | ---: | ---: | ---: |
| 195,548 voxels, JS total | 218.4 ms | 36.1 ms | 6.1× |
| Same fixture, mesh stage | 209.0 ms | 27.5 ms | 7.6× |
| Same fixture, WASM total | 218.3 ms | 33.9 ms | 6.4× |
| 819,200 source triangles, JS total | 463.9 ms | 88.7 ms | 5.2× |
| Same source, mesh stage | 370.9 ms | 37.1 ms | 10.0× |

The dense source fixture produces only 47,892 occupied voxels. Its source
triangle count should not be confused with the final voxel count.

The initial mesher benchmark used three fixtures, discarded one warm-up and reported
the median of three subsequent runs:

| Fixture | Occupied voxels | Output triangles | Geometry bytes | Mesh time |
| --- | ---: | ---: | ---: | ---: |
| Solid 128³ | 2,097,152 | 192 | 7,296 | 100.7 ms |
| Rolling, two-color terrain | 2,386,051 | 41,124 | 1,562,712 | 70.7 ms |
| Alternating occupied/empty cells | 1,048,576 | 12,582,912 | 553,648,128 | 813.2 ms |

The terrain fixture would submit 28,632,612 triangles as full cubes: the surface
mesh reduces that by about 696×. The isolated-cell case cannot merge at all;
expanded surface vertices actually cost much more memory than compact cube
instances. This is why a production renderer needs representation and LOD
budgets, rather than an unconditional promise that greedy meshing always wins.

Browser runs used a fixed 3840 × 2160 backbuffer, MSAA enabled, 30 warm-up frames,
120 measured orbiting frames and the 2.39-million-voxel terrain fixture. Chrome
and Edge identified the RTX 3090 through ANGLE/D3D11. Firefox returned a masked
renderer string on the same machine.

| Browser | Median frame interval | p95 interval | Median GPU time | p95 GPU time |
| --- | ---: | ---: | ---: | ---: |
| Chrome 152 | 16.70 ms | 17.00 ms | 1.97 ms | 3.53 ms |
| Edge 152 | 16.70 ms | 17.00 ms | 3.33 ms | 3.37 ms |
| Firefox 155 (Playwright build) | 16.66 ms | 16.68 ms | unavailable | unavailable |

All submitted 128 draw calls and 41,124 triangles, reported zero WebGL errors,
and culled all draws when the camera faced away. These runs are refresh-limited
at roughly 60 FPS. GPU milliseconds are asynchronous timer-query samples, not
CPU `renderer.render()` duration. Firefox's coarse CPU clock and unavailable
GPU timer prevent meaningful sub-millisecond GPU comparisons. The fixed camera
views the entire terrain; close-up fill cost, textured imagery, tile streaming,
That first pass did not measure Minecraft materials. The linked live-streaming
pass does; mobile/integrated GPUs and Safari remain unmeasured.

## Architecture and remaining work

### 1. Geometry and color separation — implemented

The new opaque mesher merges by occupancy and face orientation, then stores
per-voxel colors independently. One texel per voxel in varying-color rectangles
preserves near-field detail. Additional transparency/material behaviors would
need to become separate merge keys. Distant filtering remains to be implemented.

Veloren is a useful architectural reference here: its documented greedy mesh
system defers color/light texture allocation and uses atlases alongside meshes.
Its development account also describes terrain LOD and chunk/player-relative
positions. Those ideas transfer better than copying a native renderer wholesale.
See [Veloren's greedy module](https://docs.veloren.net/veloren_voxygen/mesh/greedy/index.html)
and [the developers' account](https://veloren.net/blog/devblog-81/).

### 2. Packed quads — implemented; aggregate memory budgets remain

Conventional indexed output uses 76 bytes per quad with 16-bit indices, or 88
with 32-bit indices. The packed renderer now uses 8 bytes and reconstructs the
four corners in its vertex shader. Chunk-local integer coordinates also reduce
large-world float precision loss.

Conventional meshes remain for export and existing atlas operations. Set
aggregate resident/upload budgets before building large arrays; even the packed
isolated-cell fixture needs 48 MiB of descriptors. A compact cube alternative
could be useful for chunks made almost entirely of isolated voxels.

### 3. Persistent LOD implemented; full streaming budgets remain

The map reevaluates visible tiles every 300 ms after camera interaction settles.
Projected size targets three drawing-buffer pixels per voxel. Levels differ by
exact factors of two (cap 100 gives 12.5, 25, 50, 100); upgrade above 120% of the
current level and downgrade below 80% of the next coarser level. This prevents
camera jitter from repeatedly rebuilding. Geometry settings are part of the cache
key; texture mode and brightness update shared shader resources without rebuilding.
Old meshes remain attached until replacement geometry is ready, and cache hits work
even when all build slots are occupied.

The LRU retains up to three variants per tile, targeting 128 MiB of typed output
buffers including packed atlases and export grids. Visible active representations
are protected; `window.getVoxelLodStats()` reports `overBudgetBytes` when the active
working set exceeds the target. Source geometry, serialization templates, worker
scratch memory, queued/staged results, driver allocations and framebuffers are
not covered by this counter. This bounds extra caching rather than providing a
hard resident VRAM cap. CPU geometry reconstruction/attachment have 4 ms yield
budgets, but GPU uploads and shader compilation are not yet byte-budgeted.

The actual map test drives a synthetic source through 64 → 8 → 64: two builds,
one cache hit reusing the exact original mesh, correct hide/show, and zero retained
payload after disposal. Worker tests cover pre-dispatch, queued, running and
paused-reconstruction cancellation. Chrome, Edge and Firefox pass the LOD/resource
checks. Warm-worker and cached-swap timings are fixture-specific, not an FPS claim.

The per-tile grids are nested, but independently bounded source tiles do **not**
share a global voxel lattice. Neighbor transitions/skirt geometry and color
filtering remain necessary before promising crack-free mixed-resolution terrain.
Swaps can pop; this implementation does not cross-fade them.

Keep detailed voxels nearby, coarsen geometry and color farther away, and use a
terrain heightfield or mesh in the far field when caves/overhangs are irrelevant.
Batch small chunks only within spatial groups so draw-call savings do not
destroy culling. Use resident-byte and per-frame upload budgets across all
workers, rather than multiplying a generous per-job budget by worker count.

### 4. Optimize GPU generation only after profiling transfers

The WebGPU worker still allocates a dense triangle-ID/distance volume, dispatches
every input triangle for each tile, reads the triangle volume back, then samples
colors and meshes on the CPU. Its cold closed-box smoke test was slower than
WASM. Browser API availability alone is not evidence that this path is faster.

Spatially bin triangles, reuse buffers/pipelines and compact occupied outputs
before readback. If implementing a fully GPU-resident renderer, keep occupancy,
color and face descriptors on the same device; compact visibility and feed
indirect draws without per-frame CPU readback. A same-device renderer matters:
the current map renders with WebGL while voxel generation uses worker WebGPU.
Make JS/WASM plus WebGL a maintained fallback.

Also resolve triangle ownership deterministically before extending this compute
path: the current atomic distance update followed by a separate triangle-ID
write can race between competing hits. A two-pass distance/owner selection is
one correctness-first approach. The boundary test added here does not validate
overlapping differently colored triangle ownership.

Use adapter limits, error scopes and aggregate device memory budgets. If CPU
meshing is still material, a WASM SIMD bitmask occupancy/face pass is a reasonable
next experiment; benchmark it against the new typed-array baseline. Binary
meshing only accelerates finding/merging faces, not shading or draw submission.

### 5. Address visibility and 4K fill cost separately

Retain frustum culling; add conservative hierarchical occlusion only when
overdraw profiling justifies it. Avoid synchronous per-chunk queries. A WebGPU
depth pyramid plus temporal visibility can help dense occluded scenes, provided
newly visible chunks are handled conservatively. Do not add a costly depth
prepass to this simple BasicMaterial scene without measuring a benefit.

4K is 8.29 million pixels before multisampling, overdraw or postprocessing. Use
optional render scale and AA settings for fill-limited devices while preserving
voxel density; do not silently lower world detail to hide a shading bottleneck.
MDN recommends batching, explicit VRAM budgeting and avoiding blocking WebGL
queries/readbacks in production: [WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices).
The fundamental surface-versus-cube tradeoff and greedy meshing's fragmentation
limit are explained by the algorithm's author in [Meshing in a Minecraft Game](https://0fps.net/2012/06/30/meshing-in-a-minecraft-game/).

## Reproducing the checks

Run `npm run test:mesher`, `npm run benchmark:voxel`,
`npm run benchmark:mesher`, and `npm run build`. The correctness test compares
expanded output against an independent unit-face oracle for seams, cavities,
partial chunks, colors, transformed coordinates, random grids and winding; it
also checks 32-bit indices and worker grid retention.

`npm run benchmark:webgpu` starts a temporary Vite server, opens Chrome, checks
the workers, compares all six face directions, checks disposal and compares
conventional/packed rendering of detailed-color terrain. It saves a JSON report in
`output/playwright/`, then closes its browser/server. Set `VOXEL_BROWSER` to
`msedge`, `firefox` or `webkit` to select another installed Playwright browser.
This repairs the previously missing browser benchmark runner.

Open `/scripts/voxel-render-benchmark.html` through the dev server or production
preview. Keep the tab foreground and use **Run 4K benchmark**. In its console,
`await window.runWorkerSmoke()` tests actual worker transport, WASM loading,
WebGPU generation (or a reported fallback), reconstruction and nonzero draws.
`await window.runRenderBenchmark({ fixture: 'solid' })` changes the fixture.
The `sparse` fixture allocates over 500 MiB of output geometry with
`packed: false`, or 48 MiB of descriptors with `packed: true` (the new default).

The build passes with existing NBT-export, mixed static/dynamic import and
bundle-size warnings.
