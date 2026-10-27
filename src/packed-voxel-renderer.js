import * as THREE from 'three';

const vertexShader = `
in uvec2 packedQuad;
#ifdef BATCHED_CHUNKS
in uint packedChunk;
#endif
flat out uint facePayload;
flat out uint faceTextured;
flat out uvec2 faceSize;
flat out uint faceDirection;
out vec2 faceUV;
void main() {
  uint bits = packedQuad.x;
  vec3 p = vec3(float(bits & 63u), float((bits >> 6u) & 63u), float((bits >> 12u) & 63u));
  faceSize = uvec2(((bits >> 18u) & 31u) + 1u, ((bits >> 23u) & 31u) + 1u);
  uint direction = (bits >> 28u) & 7u;
  faceDirection = direction;
  int d = int(direction >> 1u), u = (d + 1) % 3, v = (d + 2) % 3;
  // Flip the base quad in U for negative faces to preserve outward winding.
  vec2 corner = position.xy;
  if ((direction & 1u) == 0u) corner.x = 1.0 - corner.x;
  faceUV = corner * vec2(faceSize);
  p[u] += faceUV.x; p[v] += faceUV.y;
#ifdef BATCHED_CHUNKS
  p += vec3(float(packedChunk & 1023u), float((packedChunk >> 10u) & 1023u), float((packedChunk >> 20u) & 1023u)) * 32.0;
#endif
  facePayload = packedQuad.y;
  faceTextured = bits >> 31u;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const fragmentShader = `
precision highp int;
uniform sampler2D voxelColors;
uniform bool blockTextured;
uniform sampler2D blockRects;
uniform sampler2D blockAtlas;
uniform bool accurateMatching;
uniform sampler2D paletteLab;
uniform sampler2D paletteRects;
uniform int paletteCount;
uniform float brightnessBias;
flat in uint facePayload;
flat in uint faceTextured;
flat in uvec2 faceSize;
flat in uint faceDirection;
in vec2 faceUV;
out vec4 outputColor;
void main() {
  vec3 color;
  if (faceTextured != 0u) {
    uvec2 cell = uvec2(clamp(floor(faceUV), vec2(0.0), vec2(faceSize) - vec2(1.0)));
    uint texel = facePayload + cell.x + cell.y * faceSize.x;
    uint width = uint(textureSize(voxelColors, 0).x);
    color = texelFetch(voxelColors, ivec2(int(texel % width), int(texel / width)), 0).rgb;
  } else {
    color = vec3(float(facePayload & 255u), float((facePayload >> 8u) & 255u), float((facePayload >> 16u) & 255u)) / 255.0;
  }
  if (blockTextured) {
    vec4 rect;
    if (accurateMatching) {
      vec3 roots = pow(max(vec3(
        dot(color, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
        dot(color, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
        dot(color, vec3(0.0883024619, 0.2817188376, 0.6299787005))), vec3(0.0)), vec3(1.0 / 3.0));
      vec3 lab = vec3(dot(roots, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
        dot(roots, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
        dot(roots, vec3(0.0259040371, 0.7827717662, -0.8086757660)));
      lab.x = clamp(lab.x + brightnessBias, 0.0, 1.0);
      float bestDistance = 1e20;
      int best = 0;
      for (int i = 0; i < paletteCount; i++) {
        vec3 delta = lab - texelFetch(paletteLab, ivec2(i, 0), 0).rgb;
        float distanceSquared = dot(delta, delta);
        if (distanceSquared < bestDistance) { bestDistance = distanceSquared; best = i; }
      }
      rect = texelFetch(paletteRects, ivec2(best, int(faceDirection)), 0);
    } else {
      vec3 srgb = mix(color * 12.92, 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, greaterThan(color, vec3(0.0031308)));
      uvec3 bin = uvec3(clamp(floor(srgb * vec3(32.0, 64.0, 32.0)), vec3(0.0), vec3(31.0, 63.0, 31.0)));
      uint key = bin.x + 32u * (bin.y + 64u * bin.z);
      int best = int(texelFetch(blockRects, ivec2(int(key & 255u), int(key >> 8u)), 0).r);
      rect = texelFetch(paletteRects, ivec2(best, int(faceDirection)), 0);
    }
    uint axis = faceDirection >> 1u;
    float sign = (faceDirection & 1u) != 0u ? 1.0 : -1.0;
    vec2 uv = axis == 0u ? vec2(sign * faceUV.y, faceUV.x)
      : axis == 1u ? vec2(faceUV.y, sign * faceUV.x) : vec2(sign * faceUV.x, faceUV.y);
    // Address integer texels so atlas UV rounding cannot shift texture colours.
    vec2 size = vec2(textureSize(blockAtlas, 0));
    ivec2 origin = ivec2(round(rect.xy * size));
    ivec2 tileSize = ivec2(round(rect.zw * size));
    ivec2 pixel = clamp(ivec2(floor(fract(uv) * vec2(tileSize))), ivec2(0), tileSize - 1);
    color = texelFetch(blockAtlas, origin + pixel, 0).rgb;
  }
  outputColor = linearToOutputTexel(vec4(color, 1.0));
}`;

export function createPackedVoxelMesh(chunk) {
  const geometry = new THREE.InstancedBufferGeometry();
  // Small per-mesh base buffers have independent disposal ownership.
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const descriptor = new THREE.InstancedBufferAttribute(chunk.quads, 2);
  descriptor.gpuType = THREE.IntType;
  geometry.setAttribute('packedQuad', descriptor);
  if (chunk.chunkOffsets) {
    const offsets = new THREE.InstancedBufferAttribute(chunk.chunkOffsets, 1);
    offsets.gpuType = THREE.IntType; geometry.setAttribute('packedChunk', offsets);
  }
  geometry.instanceCount = chunk.quadCount;
  const dimensions = new THREE.Vector3(...chunk.dimensions);
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(), dimensions);
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());

  const texture = chunk.atlas ? new THREE.DataTexture(chunk.atlas, chunk.atlasWidth, chunk.atlasHeight, THREE.RGBAFormat) : null;
  if (texture) {
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
  }
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader, fragmentShader,
    defines: chunk.chunkOffsets ? { BATCHED_CHUNKS: 1 } : {},
    uniforms: { voxelColors: { value: texture }, blockTextured: { value: false }, blockRects: { value: null }, blockAtlas: { value: null },
      accurateMatching: { value: false }, paletteLab: { value: null }, paletteRects: { value: null }, paletteCount: { value: 0 }, brightnessBias: { value: 0 } }, toneMapped: false,
  });
  // Texture is private to this chunk; all existing tile cleanup paths dispose materials.
  material.addEventListener('dispose', () => texture?.dispose());
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.fromArray(chunk.bounds.min);
  mesh.scale.setScalar(chunk.voxelSize);
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  mesh.userData.renderMode = 'packed-surface';
  mesh.userData.chunkBounds = { min: new THREE.Vector3(...chunk.bounds.min), max: new THREE.Vector3(...chunk.bounds.max) };
  return mesh;
}

export function setPackedVoxelTextures(root, resources, enabled) {
  const active = !!(enabled && resources);
  root.traverse(node => {
    const uniforms = node.material?.uniforms;
    if (!uniforms?.blockTextured) return;
    uniforms.blockTextured.value = active;
    uniforms.blockRects.value = resources?.lookup ?? null;
    uniforms.blockAtlas.value = resources?.atlas ?? null;
    uniforms.accurateMatching.value = resources?.matchingMode === 'accurate';
    uniforms.paletteLab.value = resources?.paletteLab ?? null;
    uniforms.paletteRects.value = resources?.paletteRects ?? null;
    uniforms.paletteCount.value = resources?.paletteCount ?? 0;
    uniforms.brightnessBias.value = resources?.bias ?? 0;
  });
  root.userData.__mcApplied = active;
}
