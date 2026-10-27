import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import nbt from 'prismarine-nbt';
import { buildBlockGrid, setExportBlockPalette } from '../src/assignToBlocksForGLB.js';
import { exportTiledSchematics, partitionSparseGrid, zipFiles } from '../src/tiled-export.js';

setExportBlockPalette([{ name: 'stone', oklab: { L: .5, a: 0, b: 0 } }]);
const points = [[0, 0, 0], [127, 2, 127], [128, 2, 127], [127, 2, 128], [128, 2, 128], [999, 99, 999]];
const grid = {
  gridSize: { x: 1000, y: 100, z: 1000 }, unit: { x: 1, y: 1, z: 1 },
  bbox: { min: [-500, 0, -500], max: [500, 100, 500] },
  colorSpace: 'linear', blockMatching: 'packed',
  sparse: { indices: Float64Array.from(points.map(([x, y, z]) => x + 1000 * (y + 100 * z))), colors: new Uint32Array(points.length).fill(0xff808080) },
  exportMetadata: { metersPerBlock: 1, rotationDegrees: 37, latitude: 51.5, longitude: -.1 },
};
assert.throws(() => buildBlockGrid(grid), /too large/);
const original = structuredClone(grid);
const progress = [];
const result = await exportTiledSchematics(grid, text => progress.push(text));
assert.deepEqual(grid, original, 'Export must not alter the retained preview');
assert.equal(result.manifest.metersPerBlock, 1);
assert.equal(result.manifest.rotationDegrees, 37);
assert.equal(result.manifest.tiles.length, 5);
assert.match(progress.at(-1), /5\/5/);

// Read the ZIP as an independent consumer and verify its central directory,
// CRCs, decompressed NBT, Sponge block ordering and global placement offsets.
const archive = Buffer.concat(result.archiveParts);
const entries = new Map();
let at = 0;
while (archive.readUInt32LE(at) === 0x04034b50) {
  assert.equal(archive.readUInt16LE(at + 8), 0);
  const length = archive.readUInt32LE(at + 18), nameLength = archive.readUInt16LE(at + 26);
  const extraLength = archive.readUInt16LE(at + 28);
  const name = archive.subarray(at + 30, at + 30 + nameLength).toString();
  const start = at + 30 + nameLength + extraLength;
  const bytes = archive.subarray(start, start + length);
  assert.equal(crc32(bytes), archive.readUInt32LE(at + 14), name);
  entries.set(name, bytes); at = start + length;
}
const directoryOffset = at;
for (const name of entries.keys()) {
  assert.equal(archive.readUInt32LE(at), 0x02014b50);
  const length = archive.readUInt16LE(at + 28);
  assert.equal(archive.subarray(at + 46, at + 46 + length).toString(), name);
  assert.equal(archive.readUInt32LE(archive.readUInt32LE(at + 42)), 0x04034b50);
  at += 46 + length;
}
assert.equal(archive.readUInt32LE(at), 0x06054b50);
assert.equal(archive.readUInt16LE(at + 10), entries.size);
assert.equal(archive.readUInt32LE(at + 16), directoryOffset);
assert.deepEqual(JSON.parse(entries.get('manifest.json')), result.manifest);
const actual = new Set();
for (const tile of result.manifest.tiles) {
  const schematic = nbt.simplify((await nbt.parse(entries.get(tile.file))).parsed);
  assert.deepEqual([...schematic.Offset], [0, 0, 0]);
  assert.deepEqual([schematic.Width, schematic.Height, schematic.Length], [tile.size.x, tile.size.y, tile.size.z]);
  assert.ok(Object.values(tile.size).every(value => value <= 128));
  let position = 0, value = 0, shift = 0;
  for (const raw of schematic.BlockData) {
    const byte = raw & 255;
    value |= (byte & 127) << shift;
    if (byte & 128) { shift += 7; continue; }
    if (value) {
      assert.equal(schematic.Palette['minecraft:stone'], value);
      const x = position % schematic.Width + tile.offset.x;
      const z = Math.floor(position / schematic.Width) % schematic.Length + tile.offset.z;
      const y = Math.floor(position / (schematic.Width * schematic.Length)) + tile.offset.y;
      const key = `${x},${y},${z}`;
      assert.ok(!actual.has(key), 'Tile borders must not duplicate blocks'); actual.add(key);
    }
    position++; value = 0; shift = 0;
  }
  assert.equal(position, tile.size.x * tile.size.y * tile.size.z);
}
assert.deepEqual(actual, new Set(points.map(p => p.join(','))));
assert.throws(() => partitionSparseGrid(grid, 1000), /Tile edge/);
assert.throws(() => zipFiles([{ name: 'test', bytes: new Uint8Array(100) }], 50), /exceeds/);
await assert.rejects(exportTiledSchematics({ ...grid, sparse: { indices: new Uint32Array(), colors: new Uint32Array() } }), /no occupied/);
console.log('Tiled export: 100 million-cell scene, exact placement across borders, NBT axes, ZIP directory/CRC, metadata and preview preservation passed.');
