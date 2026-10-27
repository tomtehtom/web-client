import { createExportBlockMatcher, iterateVoxelSamples } from './assignToBlocksForGLB.js';
import { ByteWriter, writeUncompressed } from './nbt.js';
import { MINECRAFT_DATA_VERSION } from './minecraft-version.js';

const MAX_NBT_ARRAY = 0x7fffffff;
const CHUNK_BYTES = 1024 * 1024;
const varintLength = value => value < 128 ? 1 : value < 16384 ? 2 : value < 2097152 ? 3 : value < 268435456 ? 4 : 5;

// Store occupied positions only, in Sponge's x + z*width + y*width*length order.
// No allocation is proportional to the empty bounding volume.
export function buildSparseSchematic(grid) {
  if (!grid?.gridSize) throw new Error('No voxel grid to export.');
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -1, y: -1, z: -1 };
  let count = 0;
  iterateVoxelSamples(grid, ({ x, y, z }) => {
    count++;
    min.x = Math.min(min.x, x); min.y = Math.min(min.y, y); min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x); max.y = Math.max(max.y, y); max.z = Math.max(max.z, z);
  });
  if (!count) throw new Error('The scene has no occupied blocks to export.');
  const size = { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };
  const volume = size.x * size.y * size.z;
  if (Object.values(size).some(value => !Number.isInteger(value) || value < 1 || value > 65535)) {
    throw new Error('A combined schematic supports at most 65,535 blocks per axis. Reduce capture size.');
  }
  if (!Number.isSafeInteger(volume) || volume > MAX_NBT_ARRAY) {
    throw new Error('This area exceeds the schematic format’s 2,147,483,647-byte block-data limit. Reduce radius or height, or use tiled ZIP.');
  }
  const positions = new Float64Array(count), blockIds = new Uint32Array(count);
  const palette = ['minecraft:air'], remap = new Map([[palette[0], 0]]);
  const match = createExportBlockMatcher(grid);
  let used = 0, byteLength = volume;
  iterateVoxelSamples(grid, ({ x, y, z, r, g, b, state }) => {
    const name = state ?? match(r, g, b);
    if (!name) return;
    const fullName = name.includes(':') ? name : `minecraft:${name}`;
    let id = remap.get(fullName);
    if (id === undefined) { id = palette.length; palette.push(fullName); remap.set(fullName, id); }
    positions[used] = x - min.x + size.x * (z - min.z + size.z * (y - min.y));
    blockIds[used++] = id;
    byteLength += varintLength(id) - 1;
  });
  if (byteLength > MAX_NBT_ARRAY) throw new Error('Encoded block data exceeds the schematic format limit. Reduce capture size or use tiled ZIP.');
  const order = Uint32Array.from({ length: used }, (_, i) => i);
  order.sort((a, b) => positions[a] - positions[b]);
  return { size, offset: min, volume, positions, blockIds, palette, order, byteLength };
}

export function* schematicBlockChunks(blocks, chunkBytes = CHUNK_BYTES) {
  const { positions, blockIds, order, volume } = blocks;
  let buffer = new Uint8Array(chunkBytes), used = 0, cursor = 0;
  for (let n = 0; n <= order.length; n++) {
    const target = n < order.length ? positions[order[n]] : volume;
    if (target < cursor) throw new Error('Duplicate or out-of-order schematic block position.');
    let air = target - cursor;
    while (air) {
      const length = Math.min(air, buffer.length - used);
      used += length; air -= length;
      if (used === buffer.length) { yield buffer; buffer = new Uint8Array(chunkBytes); used = 0; }
    }
    if (n === order.length) break;
    let id = blockIds[order[n]];
    do {
      const next = id >>> 7;
      buffer[used++] = (id & 127) | (next ? 128 : 0); id = next;
      if (used === buffer.length) { yield buffer; buffer = new Uint8Array(chunkBytes); used = 0; }
    } while (id);
    cursor = target + 1;
  }
  if (used) yield buffer.subarray(0, used);
}

export async function writeCombinedSchematic(grid, onProgress = () => {}) {
  if (typeof CompressionStream === 'undefined') throw new Error('Combined schematic export needs gzip support. Use a current Chrome or Edge browser.');
  onProgress('Mapping occupied blocks for one combined schematic…');
  const blocks = buildSparseSchematic(grid);
  const { size, palette, byteLength } = blocks;
  const metadata = {
    Name: { type: 'string', value: 'Voxel Earth combined export' },
    VoxelEarth: { type: 'string', value: JSON.stringify({ ...grid.exportMetadata, gridOffset: blocks.offset }) },
  };
  const head = writeUncompressed({ type: 'compound', name: 'Schematic', value: {
    Version: { type: 'int', value: 2 }, DataVersion: { type: 'int', value: MINECRAFT_DATA_VERSION },
    Width: { type: 'short', value: size.x }, Height: { type: 'short', value: size.y }, Length: { type: 'short', value: size.z },
    Offset: { type: 'int[]', value: [0, 0, 0] },
    Metadata: { type: 'compound', value: metadata },
    PaletteMax: { type: 'int', value: palette.length },
    Palette: { type: 'compound', value: Object.fromEntries(palette.map((name, id) => [name, { type: 'int', value: id }])) },
  } });
  const prefix = new ByteWriter(head.length + 20);
  prefix.pushBytes(head.subarray(0, head.length - 1));
  // TAG_Byte_Array named BlockData, followed by its signed 32-bit byte count.
  prefix.pushBytes([7, 0, 9, 66, 108, 111, 99, 107, 68, 97, 116, 97]); prefix.pushI32(byteLength);
  function* rawChunks() {
    yield prefix.toUint8Array();
    let written = 0, chunks = 0;
    for (const chunk of schematicBlockChunks(blocks)) {
      written += chunk.length;
      if (chunks++ % 16 === 0) onProgress(`Compressing combined schematic… ${Math.floor(written / byteLength * 100)}%`);
      yield chunk;
    }
    yield new Uint8Array([0]); // root TAG_End
  }
  const iterator = rawChunks();
  const source = new ReadableStream({
    pull(controller) { const next = iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); },
    cancel() { iterator.return(); },
  });
  const reader = source.pipeThrough(new CompressionStream('gzip')).getReader();
  const fileParts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > 512 * 1024 * 1024) throw new Error('Combined compressed file exceeds 512 MiB. Reduce capture size.');
      fileParts.push(value);
    }
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  onProgress('Combined schematic ready.');
  return { fileParts };
}
