// Decode byte textures through shared lookup tables, avoiding twelve pow calls
// and five temporary arrays for every bilinear voxel sample.
const linearBytes = Float64Array.from({ length: 256 }, (_, i) => i / 255);
const srgbBytes = Float64Array.from(linearBytes, x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);

export function createVoxelTextureSampler({ data, width, height }, tex, srgb) {
  const table = srgb ? srgbBytes : linearBytes;
  const { offset, repeat, rotation, center, flipY, wrapS, wrapT } = tex;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const out = [0, 0, 0, 0]; // Borrowed until the next call; consumers use it immediately.
  const wrap = (value, mode) => mode === 1000 ? ((value % 1) + 1) % 1 : Math.min(1, Math.max(0, value));
  const sample = uv => {
    let u = uv.x * repeat.x + offset.x, v = uv.y * repeat.y + offset.y;
    if (rotation !== 0) {
      u -= center.x; v -= center.y;
      const x = u * cos - v * sin;
      v = u * sin + v * cos + center.y; u = x + center.x;
    }
    u = wrap(u, wrapS); v = wrap(v, wrapT); if (flipY) v = 1 - v;
    const x = u * (width - 1), y = v * (height - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const tx = x - x0, ty = y - y0;
    const i0 = (y0 * width + x0) * 4, i1 = (y0 * width + x1) * 4;
    const i2 = (y1 * width + x0) * 4, i3 = (y1 * width + x1) * 4;
    const w0 = (1 - tx) * (1 - ty), w1 = tx * (1 - ty), w2 = (1 - tx) * ty, w3 = tx * ty;
    const a0 = data[i0 + 3] / 255, a1 = data[i1 + 3] / 255, a2 = data[i2 + 3] / 255, a3 = data[i3 + 3] / 255;
    const alpha = a0 * w0 + a1 * w1 + a2 * w2 + a3 * w3;
    for (let c = 0; c < 3; c++) {
      out[c] = alpha > 1e-5 ? (table[data[i0 + c]] * a0 * w0 + table[data[i1 + c]] * a1 * w1
        + table[data[i2 + c]] * a2 * w2 + table[data[i3 + c]] * a3 * w3) / alpha : 0;
    }
    out[3] = alpha;
    return out;
  };
  sample._du = 1 / width; sample._dv = 1 / height;
  return sample;
}
