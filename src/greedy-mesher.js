import { createPackedChunkWriter } from './packed-voxel-format.js';

// Opaque surface meshing. Chunk interiors own their faces; the one-cell halo
// supplies neighbor occupancy only, so seams never emit duplicate geometry.
export function meshVoxelChunks(store, { origin = [0, 0, 0], voxelSize = 1, paletteColors8 = null, packed = false } = {}) {
  const { chunkSize: size, nx, ny, nz } = store.indexer;
  if (packed && (size > 32 || size < 1)) throw new RangeError('Packed voxel chunks must have size 1..32');
  const edge = size + 2;
  const strides = [1, edge, edge * edge];
  const halo = new Uint32Array(edge ** 3);
  const mask = new Uint32Array(size * size);
  const geometries = [];
  const packedChunks = [];
  let visibleFaceCount = 0;
  let quadCount = 0;
  let geometryBytes = 0;
  let atlasBytes = 0;
  let texturedQuadCount = 0;

  for (const chunk of store.chunks.values()) {
    halo.fill(0);
    const base = [chunk.cx * size, chunk.cy * size, chunk.cz * size];
    const dims = [Math.min(size, nx - base[0]), Math.min(size, ny - base[1]), Math.min(size, nz - base[2])];
    const low = [size, size, size], high = [0, 0, 0];
    for (let z = 0; z < dims[2]; z++) {
      for (let y = 0; y < dims[1]; y++) {
        const src = size * (y + size * z);
        const dst = 1 + edge * (y + 1 + edge * (z + 1));
        halo.set(chunk.data.subarray(src, src + dims[0]), dst);
        for (let x = 0; x < dims[0]; x++) {
          if (!chunk.data[src + x]) continue;
          low[0] = Math.min(low[0], x); high[0] = Math.max(high[0], x + 1);
          low[1] = Math.min(low[1], y); high[1] = Math.max(high[1], y + 1);
          low[2] = Math.min(low[2], z); high[2] = Math.max(high[2], z + 1);
        }
      }
    }
    if (!high[0]) continue;

    // Only six neighbor slabs are needed. No object allocation or hash lookup
    // occurs in the face sweep, and diagonal chunks cannot hide a face.
    for (let d = 0; d < 3; d++) {
      const u = (d + 1) % 3, v = (d + 2) % 3;
      for (const sign of [-1, 1]) {
        const neighborCoord = [chunk.cx, chunk.cy, chunk.cz];
        neighborCoord[d] += sign;
        const neighborBase = base[d] + sign * size;
        if (neighborBase < 0 || neighborBase >= [nx, ny, nz][d]) continue;
        const neighbor = store.chunks.get(store.indexer.key(...neighborCoord));
        if (!neighbor) continue;
        const p = [0, 0, 0];
        p[d] = sign < 0 ? size - 1 : 0;
        const hD = sign < 0 ? 0 : size + 1;
        for (let j = 0; j < dims[v]; j++) {
          p[v] = j;
          for (let i = 0; i < dims[u]; i++) {
            p[u] = i;
            halo[hD * strides[d] + (i + 1) * strides[u] + (j + 1) * strides[v]] =
              neighbor.data[p[0] + size * (p[1] + size * p[2])];
          }
        }
      }
    }

    const packedWriter = packed ? createPackedChunkWriter((x, y, z) => {
      const id = halo[x + 1 + edge * (y + 1 + edge * (z + 1))];
      if (!paletteColors8) return id;
      const offset = (id - 1) * 4;
      return paletteColors8[offset] | (paletteColors8[offset + 1] << 8) | (paletteColors8[offset + 2] << 16);
    }) : null;
    let capacity = packed ? 0 : 256, count = 0;
    let positions = new Float32Array(capacity * 12);
    let colors8 = new Uint8Array(capacity * 16);
    let indices = new Uint32Array(capacity * 6);
    const point = [0, 0, 0];
    function emit(d, u, v, plane, i, j, w, h, sign, id) {
      if (packedWriter) { packedWriter.emit(d, u, v, plane, i, j, w, h, sign); count++; return; }
      if (count === capacity) {
        capacity *= 2;
        const p = new Float32Array(capacity * 12); p.set(positions); positions = p;
        const c = new Uint8Array(capacity * 16); c.set(colors8); colors8 = c;
        const ix = new Uint32Array(capacity * 6); ix.set(indices); indices = ix;
      }
      const colorOffset = (id - 1) * 4;
      const r = paletteColors8 ? paletteColors8[colorOffset] : id & 255;
      const g = paletteColors8 ? paletteColors8[colorOffset + 1] : (id >>> 8) & 255;
      const b = paletteColors8 ? paletteColors8[colorOffset + 2] : (id >>> 16) & 255;
      point[d] = plane;
      for (let corner = 0; corner < 4; corner++) {
        point[u] = i + (corner === 1 || corner === 2 ? w : 0);
        point[v] = j + (corner >= 2 ? h : 0);
        const vertex = count * 4 + corner;
        for (let axis = 0; axis < 3; axis++) {
          positions[vertex * 3 + axis] = origin[axis] + (base[axis] + point[axis]) * voxelSize;
        }
        colors8[vertex * 4] = r; colors8[vertex * 4 + 1] = g;
        colors8[vertex * 4 + 2] = b; colors8[vertex * 4 + 3] = 255;
      }
      const vertex = count * 4, index = count * 6;
      indices[index] = vertex;
      indices[index + 1] = vertex + (sign > 0 ? 1 : 2);
      indices[index + 2] = vertex + (sign > 0 ? 2 : 1);
      indices[index + 3] = vertex;
      indices[index + 4] = vertex + (sign > 0 ? 2 : 3);
      indices[index + 5] = vertex + (sign > 0 ? 3 : 2);
      count++;
    }

    for (let d = 0; d < 3; d++) {
      const u = (d + 1) % 3, v = (d + 2) % 3;
      const width = high[u] - low[u], height = high[v] - low[v];
      for (const sign of [-1, 1]) {
        for (let slice = low[d]; slice < high[d]; slice++) {
          let visible = 0;
          const start = (slice + 1) * strides[d] + (low[u] + 1) * strides[u] + (low[v] + 1) * strides[v];
          for (let j = 0, n = 0; j < height; j++) {
            let at = start + j * strides[v];
            for (let i = 0; i < width; i++, n++, at += strides[u]) {
              const id = halo[at];
              const face = id && !halo[at + sign * strides[d]] ? id : 0;
              mask[n] = packed && face ? 1 : face;
              if (face) visible++;
            }
          }
          visibleFaceCount += visible;
          if (!visible) continue;
          for (let j = 0; j < height; j++) {
            for (let i = 0; i < width;) {
              const n = i + j * width, id = mask[n];
              if (!id) { i++; continue; }
              let w = 1, h = 1;
              while (i + w < width && mask[n + w] === id) w++;
              grow: while (j + h < height) {
                for (let k = 0; k < w; k++) if (mask[n + h * width + k] !== id) break grow;
                h++;
              }
              emit(d, u, v, slice + (sign > 0 ? 1 : 0), low[u] + i, low[v] + j, w, h, sign, id);
              for (let row = 0; row < h; row++) mask.fill(0, n + row * width, n + row * width + w);
              i += w;
            }
          }
        }
      }
    }
    if (!count) continue;
    const bounds = {
      min: base.map((value, axis) => origin[axis] + value * voxelSize),
      max: base.map((value, axis) => origin[axis] + (value + dims[axis]) * voxelSize),
    };
    if (packedWriter) {
      const chunk = packedWriter.finish();
      quadCount += count;
      geometryBytes += chunk.quads.byteLength;
      atlasBytes += chunk.atlas?.byteLength ?? 0;
      texturedQuadCount += chunk.texturedQuads;
      packedChunks.push({ ...chunk, bounds, voxelSize, dimensions: dims });
      continue;
    }
    // Exact-sized buffers matter: worker transfers include the entire backing buffer.
    positions = positions.slice(0, count * 12);
    colors8 = colors8.slice(0, count * 16);
    indices = count * 4 <= 65536 ? new Uint16Array(indices.subarray(0, count * 6)) : indices.slice(0, count * 6);
    quadCount += count;
    geometryBytes += positions.byteLength + colors8.byteLength + indices.byteLength;
    geometries.push({ positions, colors8, indices, bounds });
  }
  return { geometries, packedChunks, meshStats: { occupiedChunkCount: store.chunks.size, drawChunkCount: geometries.length + packedChunks.length, visibleFaceCount, quadCount, triangleCount: quadCount * 2, geometryBytes, atlasBytes, renderBytes: geometryBytes + atlasBytes, texturedQuadCount } };
}
