// Two uint32 words per quad, shared by the worker and WebGL2 vertex decoder.
// Word 0: x/y/z (6 bits each), width-1/height-1 (5 each), direction (3), atlas (1).
// Word 1: RGB24 for uniform faces, otherwise a linear RGBA atlas texel offset.
// Colors are linear RGB bytes, just like the conventional mesh attributes.
export function createPackedChunkWriter(sampleColor) {
  let capacity = 256, count = 0;
  let quads = new Uint32Array(capacity * 2);
  let texels = 0, texturedQuads = 0;
  let colors = new Uint8Array(0);
  const p = [0, 0, 0];
  return {
    emit(d, u, v, plane, i, j, w, h, sign) {
      if (count === capacity) {
        capacity *= 2;
        const next = new Uint32Array(capacity * 2); next.set(quads); quads = next;
      }
      p[d] = plane - (sign > 0 ? 1 : 0); p[u] = i; p[v] = j;
      const color = sampleColor(p[0], p[1], p[2]) & 0xffffff;
      let uniform = true;
      scan: for (let y = 0; y < h; y++) {
        p[v] = j + y;
        for (let x = 0; x < w; x++) {
          p[u] = i + x;
          if ((sampleColor(p[0], p[1], p[2]) & 0xffffff) !== color) { uniform = false; break scan; }
        }
      }
      let payload = color;
      if (!uniform) {
        payload = texels;
        const needed = (texels + w * h) * 4;
        if (needed > colors.length) {
          const next = new Uint8Array(Math.max(needed, colors.length * 2, 1024));
          next.set(colors); colors = next;
        }
        for (let y = 0; y < h; y++) {
          p[v] = j + y;
          for (let x = 0; x < w; x++) {
            p[u] = i + x;
            const rgb = sampleColor(p[0], p[1], p[2]), at = texels++ * 4;
            colors[at] = rgb & 255; colors[at + 1] = (rgb >>> 8) & 255;
            colors[at + 2] = (rgb >>> 16) & 255; colors[at + 3] = 255;
          }
        }
        texturedQuads++;
      }
      p[d] = plane; p[u] = i; p[v] = j;
      const direction = d * 2 + (sign > 0 ? 1 : 0);
      quads[count * 2] = (p[0] | (p[1] << 6) | (p[2] << 12) | ((w - 1) << 18)
        | ((h - 1) << 23) | (direction << 28) | (uniform ? 0 : 0x80000000)) >>> 0;
      quads[count * 2 + 1] = payload;
      count++;
    },
    finish() {
      // Each face rectangle is stored linearly, so it can cross texture rows
      // without padding, bleeding or a rectangle allocator. Shader uses texelFetch.
      const atlasWidth = texels ? Math.min(256, 2 ** Math.ceil(Math.log2(Math.sqrt(texels)))) : 0;
      const atlasHeight = texels ? Math.ceil(texels / atlasWidth) : 0;
      let atlas = null;
      if (texels) {
        atlas = new Uint8Array(atlasWidth * atlasHeight * 4);
        atlas.set(colors.subarray(0, texels * 4));
      }
      return { quads: quads.slice(0, count * 2), quadCount: count, atlas, atlasWidth, atlasHeight, texturedQuads };
    },
  };
}

// CPU decoding is useful for export adapters and independent correctness tests.
export function decodePackedQuad(quads, index) {
  const word = quads[index * 2], direction = (word >>> 28) & 7;
  return {
    position: [word & 63, (word >>> 6) & 63, (word >>> 12) & 63],
    width: ((word >>> 18) & 31) + 1, height: ((word >>> 23) & 31) + 1,
    axis: direction >>> 1, sign: (direction & 1) ? 1 : -1,
    textured: (word >>> 31) !== 0, payload: quads[index * 2 + 1],
  };
}
