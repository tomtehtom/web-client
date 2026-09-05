# Single Scene export and mobile performance

## Implementation

Single Scene now uses the map's packed greedy preview. Asking for an export grid
no longer switches voxelization back to expanded geometry. The retained export
grid stores only occupied cells: a 32-bit index and packed color, normally eight
bytes per occupied voxel. Extremely large index ranges use 64-bit indices.
Replacing a preview preserves the old mesh until the new result is attached;
cancelled or stale builds cannot replace a newer result. Minecraft toggles reuse
the preview geometry and switch the shared shader lookup.

A dedicated export worker caches the voxel grid and block assignment across
formats. GLB exports build an export-only greedy surface with hidden faces
removed. Textured surfaces use repeating block textures and merge compatible
faces. Conventional geometry is created only when needed for GLTFExporter.
The Structure NBT writer writes blocks directly into its byte buffer, avoiding
per-block intermediate JavaScript objects. All four Minecraft formats run in
the export worker. Existing export confirmation controls remain enforced.

Tileset discovery traverses independent branches concurrently, with one bounded
network queue and duplicate suppression. Mobile capture uses three concurrent
requests and three GLB loads; desktop uses six requests and eight GLB loads.
The background map stops rendering while Single Scene is open. Closing the
viewer cancels its animation frame, removes listeners, terminates its workers
and disposes owned GPU resources; late loads are discarded.

## Mobile behavior

The interface reuses [Three.js OrbitControls](https://threejs.org/docs/pages/OrbitControls.html)
for touch orbit/zoom/pan and [Leaflet](https://leafletjs.com/examples/mobile/)
for map selection. No additional UI framework is needed. Coarse-pointer devices
use a capped render pixel ratio of one, fewer CPU voxel workers, and a 48 MiB
target for additional cached LOD payloads. Active meshes remain protected.
Single Scene controls become a collapsible, scrollable bottom sheet with safe
area spacing, 44-pixel controls and 16-pixel text inputs. Portrait, landscape
and narrow 320-pixel layouts are covered. Browser page zoom is enabled.

## Measurements and validation

Measured September 5, 2026. Browser mobile profiles are desktop emulation, not
physical iOS/Android performance measurements.

| Check | Result |
| --- | --- |
| Structure NBT, 262,144 occupied blocks, median of three desktop Node trials | 395.16 ms legacy → 104.31 ms direct writer, 3.79× faster |
| Structure NBT, 1,000,000 occupied blocks, desktop Node | 376.27 ms including gzip; 2,137,919 output bytes |
| Synthetic mobile Single Scene initial preview | 3,048 voxels; 24,384-byte sparse grid; one draw call, 24 triangles |
| Rotated synthetic colored/textured GLB | 564 triangles each; 22,700 / 27,948 bytes |
| Live Paris capture, mobile profile, 50 m radius, SSE 64, density 16 | Four GLBs and 14 JSON responses; preview present at the 5.08-second sample |
| Same live capture voxelization | 406 voxels; 17 ms worker compute; 95.4 ms total client voxelization; one draw call |

The live capture is deliberately small and tests integration, not million-voxel
mobile throughput. Its loading time includes discovery, network transfer and
decode. The NBT benchmark measures serialization, not scene voxelization or GLB
export. Do not extrapolate these measurements into a universal mobile frame rate.

Chrome and WebKit mobile-emulation tests load an owned synthetic GLB through the
real client, rebuild after rapid rotation changes, export and reload colored and
textured GLBs, and compare textured rendering from six directions. Differences
from Float32 edge placement stay below 0.1% of pixels per view. Tests also cover
all four Minecraft formats, the confirmed GLB download, viewport containment,
control collapse, Chrome touch rotation and viewer teardown. Live Earth preview
testing does not export Earth data. Map LOD regression tests retain source
coverage until voxel replacements are ready.

```sh
npm run test:export
npm run test:mesher
npm run test:lod
npm run test:textures
npm run test:single-scene
# Run the browser suite with VOXEL_BROWSER=webkit for the WebKit profile.
node scripts/test-single-scene-live.mjs
npm run test:map-lod
node --expose-gc scripts/benchmark-export.mjs
npm run build
```

Reports and screenshots are written under `output/playwright/`, including
`single-scene-chrome.json`, `single-scene-webkit.json`,
`single-scene-live-mobile.json` and `export-benchmark.json`.
Set `VOXEL_BASE_URL=https://beta.voxelearth.org` when running
`test-single-scene-live.mjs` or `test-earth-coverage-browser.mjs` to test the
deployed production client instead of starting a local development server.

## Remaining limits

The export worker receives one copy of the retained sparse grid. Minecraft
formats currently use a cropped dense block volume, capped at 16 million cells
on coarse-pointer devices and 50 million on desktop. This bounds one allocation,
not total application memory. Input geometry, decoded images and format output
buffers also consume memory. A sparse scene with a very large bounding volume
can hit this limit despite having relatively few occupied cells.

Image decoding, Three.js geometry attachment and final GLTF binary serialization
still involve the main thread. A colorful GLB can be much larger than its packed
preview because conventional GLB surfaces cannot use the custom preview shader.
Large exports can therefore still pause or exhaust a phone's memory. Physical
phone profiling and additional streaming serialization are needed before making
claims about seamless million-voxel export or high-resolution mobile rendering.
