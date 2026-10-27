import { buildBlockGrid, writeSpongeSchem } from './assignToBlocksForGLB.js';

// ZIP's stored method: schematics are already gzip-compressed. Keep separate
// parts so the browser can download a Blob without another archive-sized copy.
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});
export function zipFiles(files, maxBytes = 512 * 1024 * 1024) {
  if (files.length > 65535) throw new Error('Too many export files; use a smaller area.');
  const parts = [], directory = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    const filename = encoder.encode(name);
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30 + filename.length), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true);
    h.setUint16(6, 0x800, true); h.setUint16(12, 33, true); // UTF-8, 1980-01-01
    h.setUint32(14, crc, true); h.setUint32(18, bytes.length, true); h.setUint32(22, bytes.length, true);
    h.setUint16(26, filename.length, true); header.set(filename, 30);
    const central = new Uint8Array(46 + filename.length), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint16(8, 0x800, true); c.setUint16(14, 33, true);
    c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true);
    c.setUint16(28, filename.length, true); c.setUint32(42, offset, true); central.set(filename, 46);
    parts.push(header, bytes); directory.push(central);
    offset += header.length + bytes.length;
    if (offset > maxBytes) throw new Error('Export archive exceeds 512 MiB. Export a smaller capture.');
  }
  const directorySize = directory.reduce((sum, bytes) => sum + bytes.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, directorySize, true); e.setUint32(16, offset, true);
  return [...parts, ...directory, end];
}

// Two passes over occupied cells, independent of the empty bounding volume.
// Preserve source color bytes and matcher settings exactly across tile borders.
export function partitionSparseGrid(grid, edge = 128) {
  if (!Number.isInteger(edge) || edge < 16 || edge > 128) throw new Error('Tile edge must be between 16 and 128 blocks.');
  if (!grid.sparse) throw new Error('Tiled export needs a sparse grid. Rebuild the Single Scene preview using 2.5D Scan.');
  const { indices, colors } = grid.sparse, { x: nx, y: ny } = grid.gridSize;
  const buckets = new Map();
  const keyFor = i => `${Math.floor((i % nx) / edge)},${Math.floor((Math.floor(i / nx) % ny) / edge)},${Math.floor(Math.floor(i / (nx * ny)) / edge)}`;
  for (const i of indices) {
    const key = keyFor(i);
    const bucket = buckets.get(key);
    if (bucket) bucket.count++;
    else buckets.set(key, { count: 1, at: 0 });
  }
  for (const bucket of buckets.values()) {
    bucket.indices = new indices.constructor(bucket.count);
    bucket.colors = new Uint32Array(bucket.count);
  }
  for (let at = 0; at < indices.length; at++) {
    const bucket = buckets.get(keyFor(indices[at]));
    bucket.indices[bucket.at] = indices[at]; bucket.colors[bucket.at++] = colors[at];
  }
  return buckets;
}

export async function exportTiledSchematics(grid, onProgress = () => {}) {
  const buckets = partitionSparseGrid(grid);
  if (!buckets.size) throw new Error('The scene has no occupied blocks to export.');
  if (buckets.size > 65533) throw new Error('Capture needs too many schematic files. Export a smaller area.');
  const manifest = {
    version: 1, format: 'Sponge schematic v2', tileEdgeBlocks: 128,
    origin: 'Minimum corner of the complete voxel grid. Choose its Minecraft base X/Y/Z, then add each tile offset.',
    axes: '+X east, +Y up, -Z north before rotation',
    ...grid.exportMetadata,
    gridSize: grid.gridSize, tiles: [],
  };
  const files = [];
  const totalTiles = buckets.size;
  let archiveBytes = 0, number = 0;
  for (const [key, bucket] of buckets) {
    onProgress(`Writing schematic ${++number}/${totalTiles}…`);
    const blocks = buildBlockGrid({ ...grid, sparse: { indices: bucket.indices, colors: bucket.colors } }, { maxCells: 128 ** 3 });
    const name = `tiles/tile_${key.replaceAll(',', '_')}.schem`;
    const bytes = await writeSpongeSchem(blocks);
    archiveBytes += bytes.length;
    if (archiveBytes > 512 * 1024 * 1024) throw new Error('Export archive exceeds 512 MiB. Export a smaller capture.');
    files.push({ name, bytes });
    manifest.tiles.push({ file: name, offset: blocks.offset, size: blocks.size, occupiedBlocks: bucket.count });
    // Release each partition as soon as it has been serialized.
    buckets.delete(key);
  }
  files.push({ name: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest, null, 2)) });
  files.push({ name: 'README.txt', bytes: encoder.encode(`Voxel Earth tiled Minecraft export

Extract tiles/*.schem into your WorldEdit or FAWE schematics folder.
Choose base X, Y, Z for the MINIMUM corner of the complete exported grid.
For each manifest.json entry, add offset.x/y/z to that base position.
Teleport to that exact integer position, then run:
  //schem load <tile filename without .schem>
  //paste -a
Do not rotate individual tiles. Rotation was applied before voxelization.
Use the same base for every tile. Schematic internal Offset is zero.
The archive omits empty tiles. -a skips air and preserves existing blocks.
Back up the destination world before pasting.

Metres per block: ${manifest.metersPerBlock ?? 'density mode (see manifest)'}
Y rotation: ${manifest.rotationDegrees ?? 0} degrees
Grid size: ${grid.gridSize.x} x ${grid.gridSize.y} x ${grid.gridSize.z} blocks
Check that base Y plus grid height fits your world's build limits.

Tile exports bound serialization allocations, but the complete scene is still
loaded and voxelized in browser memory. This is not an unlimited-area exporter.
`) });
  return { archiveParts: zipFiles(files), manifest };
}
