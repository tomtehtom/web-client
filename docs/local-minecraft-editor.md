# Local Minecraft editor

## Minecraft 26.3 palette

The registry, textures, block colour references and export DataVersion now target
**vanilla Java 26.3**. The atlas is baked from the installed 26.3 client JAR, with
default states pinned to the game's generated block-state summary. It contains
1,286 registered IDs, 435 supported textured default-state full cubes, and a
369-block **Use all opaque solid blocks** preset. Falling/support-dependent blocks
are excluded. Partial models such as stairs, slabs and plants are not treated as
full cubes; transparent full cubes can be selected explicitly through custom lists.
`public/minecraft-palette-audit.json` records every supported/excluded classification.

All 319 non-gravity opaque full cubes from the previous 1.20 collision-shape audit
are covered, including the 87 previously missing direct texture mappings. New
26.3 blocks such as Poplar planks/logs are included. Existing user palette choices
are preserved; select the all-solids preset to enable the complete opaque set.

Models resolve inherited texture aliases, default blockstate variants and
multipart components. Grass overlays and biome-tinted textures use a fixed plains
reference; animation textures use their first frame. Closed shulker boxes are
baked from the entity texture layout. This is a static vanilla reference, not a
simulation of your world's biome, resource pack, shaders, light or time of day.

Colour profiles average texture samples in **linear light**, then convert to
sRGB/OKLab for matching. **Balanced** weights six faces equally; **Terrain** uses
the top face; **Buildings** uses the four sides. Choose Terrain for top-down land
surfaces and Buildings for predominantly vertical geometry. This choice changes
matching without downloading or voxelizing again. Preview and textured GLB export
use distinct top/bottom/side textures, independent of the matching reference.

Schematic and Structure NBT exports now write **DataVersion 5023**. The legacy
numeric-registry export wrapper was replaced with the name-based writer so new
block IDs do not silently become air. Legacy MCEdit format remains inherently
limited and cannot represent new Minecraft blocks accurately; use `.schem`.

The checked-in generated files work without a local Minecraft installation.
To rebuild them, run `scripts/build-minecraft-palette.py` with Pillow/numpy and
`--jar` pointing to a vanilla 26.3 client JAR. It defaults to the installed Windows
26.3 path and never changes the game installation. Default-state provenance is
[`misode/mcmeta` 26.3-summary](https://github.com/misode/mcmeta/tree/26.3-summary/blocks).

On Windows, double-click **Start-Editor.cmd**, then open
<http://127.0.0.1:5173/>. Keep the launcher window open while using the editor;
press Ctrl+C in that window to stop it. Stop it before moving/replacing the
repository folder in GitHub Desktop.

The launcher uses an installed supported Node version, or the bundled Codex
runtime on this computer if the installed Node is too old. For a standalone
installation on another computer, install Node.js 24 LTS with npm. The first
launch installs the locked dependencies. It uses the Windows trusted certificate
store for HTTPS; certificate verification stays enabled.

## Scale, orientation and capture

1. Select **Single Scene** and choose a location.
2. Set the radius and fetch tiles. Radius now accepts 20–20,000 metres. It selects
   intersecting source tiles, so their outer edges can extend beyond the radius;
   it does not cut a precise circular boundary.
3. Leave **Minecraft scale → Exact metres per block** selected and set **1** for
   a life-size grid. **2** makes one Minecraft block represent two metres.
4. Adjust **Rotation (Y)** before export. At zero, east is Minecraft +X, up is +Y,
   and north is −Z. Positive angles turn east toward north. Both the voxel preview
   and the export show the resulting orientation. Rotation does not change the
   metre grid spacing.
5. Wait for the dimensions and block size below the scale controls to update.

### Source geometry detail and progress

The former Single Scene "SSE" control compared tile `geometricError` directly
against the input. It was not calculating camera-based pixel SSE. It is now
labelled **Source detail threshold (metres)** and defaults to **1 m**. Lower
values request finer source geometry. For 1 m blocks, start at 1 m and compare
0.5 m on a small capture if necessary. Enable **Highest available source detail**
to descend to leaf tiles, including parents whose error is zero. This can fetch
substantially more geometry without a visible improvement on the final 1 m grid.
Change source detail before fetching; changing it requires fetching again.
It changes source selection, not metres per Minecraft block.

Discovery now reports elapsed time, completed tileset requests, active/queued
requests, visited nodes and discovered model counts every two seconds. Its total
is unknown until traversal finishes, so it does not show an invented percentage.
Model downloads/decoding report completed/failed counts and elapsed time. Worker
logs identify geometry preparation, triangle voxelization, colour sampling, mesh
construction, sparse grid preparation and preview attachment. Long worker stages
also have a three-second elapsed-time heartbeat. Counter percentages describe
their individual stage, not total capture completion. Capture/build identifiers
distinguish messages from different operations; final timings help identify the
slow stage. Per-model completion logs are throttled rather than appending
thousands of individual lines to the panel.

### Choosing Minecraft blocks

The **Minecraft block palette** controls below the scale settings select wool,
concrete, terracotta, optional glazed terracotta, and optional other blocks from
the existing palette. Defaults are all **16 wool + 16 concrete + 16 coloured
terracotta + plain terracotta**, or 49 blocks. Glazed terracotta adds 16.
Sand, red sand, gravel, suspicious sand/gravel, concrete powder, anvils, dragon
eggs, scaffolding and pointed dripstone are excluded even when other blocks are
enabled. Soul sand is not a falling block.

The **Minecraft textures** toggle now sits inside this palette section in
Single Scene. The same toggle remains accessible in rendering Options while
using the streaming map; moving between modes preserves its state.

### Importing and exporting block lists

- **Export full block list** writes `minecraft-block-list.json`: all 1,286
  registered Minecraft 26.3 block IDs, their editable `enabled` flags, and support
  notes. This matches the bundled 26.3 assets; it is not a newer-version or modded
  registry. Blocks without a supported atlas texture, and falling/support-dependent
  blocks, are marked unsupported.
- **Export selected blocks** writes a simple JSON array of the currently allowed
  block IDs, useful for sharing or maintaining a small custom palette.
- **Import block list** accepts either exported JSON file, a JSON array of IDs,
  or a text list with one ID per line. Bare names such as `stone` are accepted
  as `minecraft:stone`; block-state properties and custom namespaces are not.

Edit `enabled` flags in the full file and import it to apply the list. Imports
replace the block-family selection and disable its checkboxes while custom mode
is active. **Use block families** restores those controls. Custom lists persist
in this browser and update matching without fetching or voxelizing again.
Explicit custom lists can enable textured blocks excluded by the default family
preferences, such as ores. Falling-block exclusions remain mandatory.

Unknown or unsupported enabled IDs are skipped and reported. Invalid JSON or a
list with no supported enabled entries leaves the current palette intact. Files
are limited to 2 MiB and 10,000 entries. Imported support flags cannot override
the editor's own compatibility checks. The full list does not include new textures
or implement missing block models; it records which registry blocks this editor
can currently use.

Example selected-block file:

```json
["minecraft:white_wool", "minecraft:red_concrete", "minecraft:stone"]
```

Selections persist in this browser. Matching uses the actual atlas texture
colours in OKLab space. Palette changes replace the Minecraft preview lookup and
export palette without rebuilding the voxel geometry or fetching tiles again.
The normal coloured voxel preview shows source colours; enable Minecraft
textures in rendering Options to see the selected blocks.

**Accurate — nearest OKLab colour** is the default colour matching mode. It
queries the actual voxel colour without rounding to a coarse RGB bin. The
Minecraft preview evaluates nearest palette colours in its shader; exports
use the same OKLab distance rule with an exact-colour cache. The cache is bounded
and never groups different colours into one approximate answer. Matching compares
against average block texture colours, so a texture's individual bright/dark
pixels or its appearance under Minecraft lighting can differ from that average.
Only enabled block families are eligible: turn on **Other blocks** to include
the existing stone/wood/etc. palette rather than just coloured blocks.

**Fast — approximate colour bins** retains the previous lookup approach for
faster textured preview rendering, at the cost of possible near-colour mistakes.
Accurate preview costs more GPU work, especially with large enabled palettes.
Changing the mode updates the preview/export matching immediately and persists
in this browser; no tile download or geometry rebuild is required.

### When settings apply in Single Scene

| Control | Effect | Apply |
| --- | --- | --- |
| Location, radius, source detail threshold/highest detail | Changes downloaded source geometry | Fetch Tiles again |
| Minecraft textures | Shows chosen Minecraft blocks instead of source colours | Immediate; does not change voxel size or switch schematic export on/off |
| Palette, colour matching | Changes allowed blocks and matching accuracy | Immediate; reuses geometry |
| Voxelization method | Changes the algorithm sampling the loaded source | Automatic rebuild; no refetch |
| Metres per block, rotation | Changes grid size or alignment | Automatic rebuild; no refetch |
| Single Scene density presets | Changes density only in legacy density mode | Automatic rebuild in that mode; ignored in metric mode |
| Main map resolution presets in Options | Changes the streaming map | Disabled while in Single Scene |

At **1 metre per block**, the cell size stays one metre regardless of algorithm
or Low/Medium/High/Ultra density presets. For finer cells, change metres per block
(for example 0.5 m); that changes the exported Minecraft scale. To keep life size
while improving input fidelity, lower the source detail threshold and refetch.

### Triangular colour patches

The colour sampler previously used an absolute determinant cutoff when
interpolating triangle UV coordinates. Normalizing a large capture to the small
preview coordinate range pushed valid source triangles below that cutoff. Those
triangles used a single centroid texture sample for every voxel, creating flat
triangle-shaped colour patches. The worker and legacy colour samplers now use
an edge-length-relative degeneracy test so interpolation does not depend on the
capture scale. Truly degenerate triangles retain a centroid fallback.

Click **Rebuild voxel preview** to regenerate colours from loaded geometry. A
new tile download is not required while the source scene is still loaded. This
addresses sampling artifacts; seams and exposure differences baked into the
source imagery can still be present.

Metric size is passed directly to voxelization after accounting for the preview's
normalization. It does not depend on the density preset, capture extent, or
rotated bounding-box dimensions. Source geometry is sampled at the requested
spacing; source accuracy and voxel rounding still limit the resulting detail.
**Per-tile density (legacy)** is available for comparison and enables the old
density controls. It does not guarantee a chosen metre spacing.

## Exporting a large area

Choose **Combined WorldEdit / FAWE (.schem)**, the default. This downloads one
`structure.schem` containing the entire area at its selected scale and rotation.
Put it in your server's configured FAWE/WorldEdit schematics folder. Stand where
you want the minimum corner of the exported area and run:

```text
//schem load structure
//paste -a
```

This is one load and one paste; no tile alignment is required. `-a` skips air.
The exporter maps and sorts only occupied blocks, then streams the full Sponge
v2 block data through gzip in 1 MiB chunks. It does not allocate the whole area's
dense block volume and is not subject to the old 50-million-cell desktop cap.
It still processes the empty positions as required by the schematic format.

Sponge v2 supports 65,535 blocks per axis and a signed 32-bit byte-array length:
combined encoded BlockData must fit within 2,147,483,647 bytes, including varints.
The exporter reports a specific error before writing if this is exceeded.
Compressed output is capped at 512 MiB. FAWE must also have enough resources to
load and paste the clipboard. A very wide region can exceed a format limit even
when very few positions contain blocks. See the
[Sponge v2 specification](https://github.com/SpongePowered/Schematic-Specification/blob/master/versions/schematic-2.md).

The existing export rights confirmations still apply. Choose a base Y that fits
the complete height into the destination world's build range. Photogrammetry
describes surfaces; the exporter does not invent building interiors or terrain
below those surfaces.

### Optional tiled export

**Tiled WorldEdit schematics (.zip)** remains available as an alternative for
captures exceeding the combined format limits. An archive contains:

- `tiles/*.schem`: Sponge v2 schematics, each at most 128 blocks per axis.
- `manifest.json`: common grid size, actual scale, rotation, capture metadata
  when available, and every tile's placement offset and dimensions.
- `README.txt`: instructions for pasting the sections into Minecraft.

Extract the schematics into the WorldEdit/FAWE schematics folder for your server.
Choose one Minecraft base X/Y/Z for the **minimum corner of the complete grid**.
For each manifest entry, add its offset to that base, teleport to the resulting
integer position, load its schematic with `//schem load`, then use `//paste -a`.
Internal schematic offsets are zero. Do not rotate tiles individually. All tiles
come from one voxelization and share one grid, so their placement offsets align
without resampling. Independent captures do not share an automatic world anchor.

Air is skipped when pasting with `-a`, and empty sections are omitted from the archive.

The NBT, legacy schematic, mcfunction and textured GLB paths retain their existing
dense-volume limits. The tiled option serializes one small dense section at a time. The original
geometry, images, sparse voxel grid, partitions and compressed output still use
browser memory. A 20 km control limit is not a promise that a fully detailed
20 km capture will fit in memory. ZIP output is capped at 512 MiB; reduce capture
size if it exceeds that limit. No in-game import command is added by this change.

## Validation

`npm run test:minecraft-assets` verifies registry/version metadata, every baked
face mapping and colour profile, exclusions, Poplar/grass/log/shulker coverage,
and all 319 opaque cubes from the previous collision-shape baseline.
Run the Single Scene browser suite with `VOXEL_FACE_FIXTURE=1` to force grass blocks
and compare preview/export textures from all six directions. The regular suite
also covers the all-solid preset, Terrain colour reference, and DataVersion 5023.

`npm run test:palette-files` checks the registry and JSON/text parsing, round
trips, duplicate IDs, authoritative exclusions, and malformed/empty/version/size
errors. Browser tests verify the moved toggle, both downloads, custom matching
without rebuilding, invalid-import preservation, full-list round trips and reset.

`npm run test:colour-matching` reproduces the old same-bin mistake, checks exact
palette colours match themselves in any query order, and compares close-colour
selections against an independent nearest-OKLab oracle. Browser checks cover
matching-mode updates, shader errors, algorithm changes rebuilding Single Scene
without refetching, and the disabled main-map density controls.

`npm run test:triangle-colours` uses an owned gradient texture and both diagonals
of the same surface through the default Scan worker. The regression reproduces
the old triangle patches after normalization, then checks unchanged voxel
colours across scales from 1 to 0.000001, and preservation of a uniform colour.

`npm run test:palette-progress` checks all 49 default colours, optional glazed
colours, falling-block exclusion, finer-detail traversal, discovery timer cleanup
and worker progress stages. The browser suite also checks that changing a palette
updates the Minecraft lookup and preserves the mesh, and that worker progress
messages reach the log without finishing the worker job prematurely.

`npm run test:combined-schematic` compares the decoded combined file against the
existing writer for colors, palette, axes and empty cells. It also checks varints
split across chunks, format-limit errors, preview preservation, and a single
100-million-cell schematic without a dense allocation.

`npm run test:tiled-export` verifies a sparse scene spanning 100 million cells,
tile-border placement without missing/duplicate blocks, NBT axis order, ZIP
directory/CRC integrity, metadata, and preservation of the preview grid.

`npm run test:metric-scene` uses a procedural GLB in a real browser to check
1 m/block, 2 m/block, a 90-degree rotation, expected dimensions, the scale UI,
the combined schematic and ZIP downloads, a 100-million-cell combined export
through the real worker, worker metadata and mobile overflow. It exports only the
procedural fixture. Set `VOXEL_BROWSER` to another installed Chromium channel
if Microsoft Edge is unavailable.

The existing export, mesher and Single Scene browser suites cover the legacy
formats, packed rendering and GLB round trips. Tests do not constitute a live
Minecraft import or a large real-world download benchmark.
