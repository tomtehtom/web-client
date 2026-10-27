import { ByteWriter, writeUncompressed } from './nbt.js';
import { MINECRAFT_DATA_VERSION } from './minecraft-version.js';

// Write each occupied block straight to bytes, avoiding two object graphs with
// several objects and arrays per voxel before NBT encoding even starts.
export async function writeStructureGrid({ size, palette, data }, dataVersion = MINECRAFT_DATA_VERSION) {
  const head = writeUncompressed({ type: 'compound', name: '', value: {
    DataVersion: { type: 'int', value: dataVersion },
    size: { type: 'list', value: { type: 'int', value: [size.x, size.y, size.z] } },
    palette: { type: 'list', value: { type: 'compound', value: palette.map(name => ({ Name: { type: 'string', value: `minecraft:${name}` } })) } },
  } });
  let count = 0;
  for (const value of data) if (value >= 0) count++;
  const bytes = new ByteWriter(Math.max(65536, head.length + count * 36 + 40));
  bytes.pushBytes(head.subarray(0, head.length - 1));
  // TAG_List("blocks"), TAG_Compound, count.
  bytes.pushBytes([9, 0, 6, 98, 108, 111, 99, 107, 115, 10]); bytes.pushI32(count);
  for (let i = 0; i < data.length; i++) if (data[i] >= 0) {
    // TAG_List("pos"), TAG_Int, length 3.
    bytes.pushBytes([9, 0, 3, 112, 111, 115, 3, 0, 0, 0, 3]);
    bytes.pushI32(i % size.x); bytes.pushI32(Math.floor(i / size.x) % size.y);
    bytes.pushI32(Math.floor(i / (size.x * size.y)));
    bytes.pushBytes([3, 0, 5, 115, 116, 97, 116, 101]); bytes.pushI32(data[i]); bytes.pushByte(0);
  }
  // Empty entities list, followed by root end.
  bytes.pushBytes([9, 0, 8, 101, 110, 116, 105, 116, 105, 101, 115, 10, 0, 0, 0, 0, 0]);
  const raw = bytes.buffer.subarray(0, bytes.length);
  if (typeof CompressionStream === 'undefined') return raw;
  return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
