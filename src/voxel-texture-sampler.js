// Decode byte textures through shared lookup tables, avoiding twelve pow calls
// and five temporary arrays for every bilinear voxel sample.
const linearBytes = Float64Array.from({ length: 256 }, (_, i) => i / 255);
const srgbBytes = Float64Array.from(linearBytes, x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);

export function createVoxelTextureSampler({ data, width, height }, tex, srgb) {
  const table = srgb ? srgbBytes : linearBytes;
  const { offset={x:0,y:0}, repeat={x:1,y:1}, rotation=0, center={x:0,y:0}, flipY, wrapS, wrapT } = tex;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const out = [0, 0, 0, 0]; // Borrowed until the next call; consumers use it immediately.
  const wrap = (value, mode) => {
    if(mode===1000)return ((value%1)+1)%1;
    if(mode===1002){const v=((value%2)+2)%2;return v>1?2-v:v;}
    return Math.min(1,Math.max(0,value));
  };
  const address=(index,size,mode)=>mode===1000?((index%size)+size)%size:Math.min(size-1,Math.max(0,index));
  // Same transform as THREE.Matrix3.setUvTransform, including scaled centres.
  const m00=repeat.x*cos,m01=repeat.x*sin,m02=-repeat.x*(cos*center.x+sin*center.y)+center.x+offset.x;
  const m10=-repeat.y*sin,m11=repeat.y*cos,m12=-repeat.y*(-sin*center.x+cos*center.y)+center.y+offset.y;
  const sample = uv => {
    let u = m00*uv.x+m01*uv.y+m02,v=m10*uv.x+m11*uv.y+m12;
    u = wrap(u, wrapS); v = wrap(v, wrapT); if (flipY) v = 1 - v;
    // Normalized UVs address texel centres at (i+.5)/size, exactly like WebGL.
    // Multiplying by size-1 shifts atlas-chart borders into adjacent imagery.
    const x = u * width - .5, y = v * height - .5;
    const ix=Math.floor(x),iy=Math.floor(y),tx=x-ix,ty=y-iy;
    const x0=address(ix,width,wrapS),x1=address(ix+1,width,wrapS);
    const y0=address(iy,height,wrapT),y1=address(iy+1,height,wrapT);
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
