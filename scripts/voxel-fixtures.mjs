// Shared deterministic fixtures for Node correctness tests and browser rendering.
export function makeStore(nx, ny, nz, sample, chunkSize = 32) {
  const chunkCountX = Math.ceil(nx / chunkSize), chunkCountY = Math.ceil(ny / chunkSize);
  const indexer = { nx, ny, nz, chunkSize, key: (x, y, z) => x + chunkCountX * (y + chunkCountY * z) };
  const chunks = new Map();
  let voxelCount = 0;
  for (let cz = 0; cz * chunkSize < nz; cz++) {
    for (let cy = 0; cy * chunkSize < ny; cy++) {
      for (let cx = 0; cx * chunkSize < nx; cx++) {
        const data = new Uint32Array(chunkSize ** 3);
        let count = 0;
        for (let z = 0; z < Math.min(chunkSize, nz - cz * chunkSize); z++) {
          for (let y = 0; y < Math.min(chunkSize, ny - cy * chunkSize); y++) {
            for (let x = 0; x < Math.min(chunkSize, nx - cx * chunkSize); x++) {
              const id = sample(cx * chunkSize + x, cy * chunkSize + y, cz * chunkSize + z) >>> 0;
              data[x + chunkSize * (y + chunkSize * z)] = id;
              if (id) count++;
            }
          }
        }
        if (count) chunks.set(indexer.key(cx, cy, cz), { cx, cy, cz, data });
        voxelCount += count;
      }
    }
  }
  return { indexer, chunks, voxelCount };
}

export function makeMillionVoxelFixture(kind = 'terrain') {
  if (kind === 'solid') return makeStore(128, 128, 128, () => 0xffba8753);
  if (kind === 'sparse') return makeStore(128, 128, 128, (x, y, z) => (x + y + z) % 2 ? 0xffba8753 : 0);
  if (kind !== 'terrain' && kind !== 'colored') throw new Error(`Unknown fixture: ${kind}`);
  return makeStore(256, 64, 256, (x, y, z) => {
    const height = 36 + Math.floor(10 * Math.sin(x * 0.06) * Math.cos(z * 0.045));
    if (y > height) return 0;
    if (kind === 'colored') {
      const hash = Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ Math.imul(z + 1, 83492791);
      return (0xff000000 | (hash & 0xffffff)) >>> 0;
    }
    return y === height ? 0xff397853 : 0xff547497;
  });
}
