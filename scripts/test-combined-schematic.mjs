import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import nbt from 'prismarine-nbt';
import { buildBlockGrid, setExportBlockPalette, writeSpongeSchem } from '../src/assignToBlocksForGLB.js';
import { buildSparseSchematic, schematicBlockChunks, writeCombinedSchematic } from '../src/combined-schematic.js';

setExportBlockPalette([
  { name: 'stone', oklab: { L: .5, a: 0, b: 0 } },
  { name: 'dirt', oklab: { L: .1, a: 0, b: 0 } },
  { name: 'quartz_block', oklab: { L: .9, a: 0, b: 0 } },
]);
const grid = {
  gridSize: { x: 9, y: 4, z: 13 }, colorSpace: 'linear', blockMatching: 'packed',
  sparse: { indices: Float64Array.from([[8, 3, 12], [2, 1, 4], [5, 2, 8], [3, 1, 10]].map(([x, y, z]) => x + 9 * (y + 4 * z))),
    colors: Uint32Array.from([0xff808080, 0xff000000, 0xffffffff, 0xff707070]) },
  exportMetadata: { metersPerBlock: 1, rotationDegrees: 37 },
};
const original = structuredClone(grid);
const result = await writeCombinedSchematic(grid);
const actual = nbt.simplify((await nbt.parse(Buffer.concat(result.fileParts))).parsed);
const reference = nbt.simplify((await nbt.parse(Buffer.from(await writeSpongeSchem(buildBlockGrid(grid))))).parsed);
const metadata = JSON.parse(actual.Metadata.VoxelEarth);
assert.equal(metadata.metersPerBlock, 1); assert.equal(metadata.rotationDegrees, 37);
assert.deepEqual(metadata.gridOffset, { x: 2, y: 1, z: 4 });
delete actual.Metadata;
assert.deepEqual(actual, reference, 'Combined output must match the existing writer, including color matching, cropped dimensions, palette and air');
assert.deepEqual(grid, original, 'Export must not detach or alter the preview grid');

// Force multi-byte varints to split across chunk boundaries.
const varints = { positions: new Float64Array([0, 2, 4]), blockIds: new Uint32Array([127, 128, 16384]), order: new Uint32Array([0, 1, 2]), volume: 6 };
assert.deepEqual([...Buffer.concat([...schematicBlockChunks(varints, 1)])], [127, 0, 128, 1, 0, 128, 128, 1, 0]);

// This volume fails the previous dense writer. Inspect the streamed gzip
// without allocating its 100 MB uncompressed BlockData or a dense block grid.
setExportBlockPalette([{ name: 'stone', oklab: { L: .5, a: 0, b: 0 } }]);
const points = [[0, 0, 0], [127, 2, 127], [128, 2, 127], [127, 2, 128], [128, 2, 128], [999, 99, 999]];
const large = {
  gridSize: { x: 1000, y: 100, z: 1000 },
  sparse: { indices: Float64Array.from(points.map(([x, y, z]) => x + 1000 * (y + 100 * z))), colors: new Uint32Array(points.length).fill(0xff808080) },
};
assert.throws(() => buildBlockGrid(large), /too large/);
const sparse = buildSparseSchematic(large);
assert.equal(sparse.positions.length, points.length);
assert.equal(sparse.volume, 100_000_000);
const largeResult = await writeCombinedSchematic(large);
assert.ok(largeResult.fileParts.reduce((sum, part) => sum + part.byteLength, 0) < 200_000);
const expected = points.map(([x, y, z]) => x + 1000 * (z + 1000 * y)).sort((a, b) => a - b);
const found = [];
let rawOffset = 0, dataOffset;
const blockTag = Buffer.from([7, 0, 9, 66, 108, 111, 99, 107, 68, 97, 116, 97]);
for await (const chunk of Readable.from(largeResult.fileParts).pipe(createGunzip())) {
  if (dataOffset === undefined) {
    const index = chunk.indexOf(blockTag); assert.ok(index >= 0);
    assert.equal(chunk.readInt32BE(index + blockTag.length), 100_000_000);
    dataOffset = index + blockTag.length + 4;
  }
  const start = Math.max(0, dataOffset - rawOffset), end = Math.min(chunk.length, dataOffset + 100_000_000 - rawOffset);
  for (let i = start; i < end; i++) if (chunk[i]) {
    assert.equal(chunk[i], 1); found.push(rawOffset + i - dataOffset);
  }
  rawOffset += chunk.length;
}
assert.deepEqual(found, expected, 'One combined schematic must preserve global X/Z/Y order across all former tile boundaries');
assert.equal(rawOffset, dataOffset + 100_000_000 + 1);
assert.throws(() => buildSparseSchematic({ gridSize: { x: 65536, y: 1, z: 1 }, sparse: { indices: new Float64Array([0, 65535]), colors: new Uint32Array([0xffffffff, 0xffffffff]) } }), /65,535/);
assert.throws(() => buildSparseSchematic({ gridSize: { x: 50000, y: 2, z: 50000 }, sparse: { indices: new Float64Array([0, 4_999_999_999]), colors: new Uint32Array([0xffffffff, 0xffffffff]) } }), /block-data limit/);
assert.throws(() => buildSparseSchematic({ gridSize: { x: 1, y: 1, z: 1 }, sparse: { indices: new Uint32Array(), colors: new Uint32Array() } }), /no occupied/);
console.log('Combined schematic: independent NBT round-trip, colors/air/axes, varint chunk boundaries, 100-million-cell sparse export and format limits passed.');
