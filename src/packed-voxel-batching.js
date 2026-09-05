// Batch only within one source tile, retaining source-tile frustum culling.
// One extra uint per quad locates its 32-voxel chunk. Color rectangles are
// concatenated without resampling; their descriptors get a new linear offset.
export function batchPackedVoxelChunks(chunks, maxAtlasTexels = 2048 * 2048) {
  const output = [];
  let pending = [], texels = 0;
  const flush = () => {
    if (!pending.length) return;
    if (pending.length === 1) { output.push(pending[0]); pending = []; texels = 0; return; }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let count = 0, texturedQuads = 0;
    for (const chunk of pending) {
      count += chunk.quadCount; texturedQuads += chunk.texturedQuads;
      for (let d = 0; d < 3; d++) { min[d] = Math.min(min[d], chunk.bounds.min[d]); max[d] = Math.max(max[d], chunk.bounds.max[d]); }
    }
    const voxelSize = pending[0].voxelSize;
    const dimensions = min.map((v, d) => Math.round((max[d] - v) / voxelSize));
    if (dimensions.some(value => value > 32768)) { output.push(...pending); pending = []; texels = 0; return; }
    const quads = new Uint32Array(count * 2), chunkOffsets = new Uint32Array(count);
    const atlasWidth = texels ? Math.min(2048, 2 ** Math.ceil(Math.log2(Math.sqrt(texels)))) : 0;
    const atlasHeight = texels ? Math.ceil(texels / atlasWidth) : 0;
    const atlas = texels ? new Uint8Array(atlasWidth * atlasHeight * 4) : null;
    let at = 0, colorAt = 0;
    for (const chunk of pending) {
      const offset = min.map((v, d) => Math.round((chunk.bounds.min[d] - v) / (voxelSize * 32)));
      const code = offset[0] | (offset[1] << 10) | (offset[2] << 20);
      quads.set(chunk.quads, at * 2); chunkOffsets.fill(code, at, at + chunk.quadCount);
      for (let q = at; q < at + chunk.quadCount; q++) if (quads[q * 2] >>> 31) quads[q * 2 + 1] += colorAt;
      if (chunk.atlas) { atlas.set(chunk.atlas, colorAt * 4); colorAt += chunk.atlas.length / 4; }
      at += chunk.quadCount;
    }
    output.push({ quads, chunkOffsets, quadCount: count, atlas, atlasWidth, atlasHeight, texturedQuads, voxelSize, dimensions, bounds: { min, max } });
    pending = []; texels = 0;
  };
  for (const chunk of chunks) {
    const size = (chunk.atlas?.length ?? 0) / 4;
    if (pending.length && texels + size > maxAtlasTexels) flush();
    pending.push(chunk); texels += size;
  }
  flush(); return output;
}
