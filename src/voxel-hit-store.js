const PAGE_SIZE = 1024;
const hash = (key, capacity) => (key * 2654435761 >>> 0) & (capacity - 1);
const makePage = capacity => ({ keys: new Uint16Array(capacity), triangles: new Int32Array(capacity), distances: new Float64Array(capacity), count: 0 });

// Map entries represent pages, never individual voxels. Sparse pages start small
// and promote to dense arrays when that is cheaper than hash-table slack.
export class SparseVoxelHits {
  constructor() { this.pages = new Map(); this.size = 0; }
  setIfCloser(index, triangle, distance) {
    const pageIndex = Math.floor(index / PAGE_SIZE), offset = index - pageIndex * PAGE_SIZE;
    let page = this.pages.get(pageIndex);
    if (!page) { page = makePage(16); this.pages.set(pageIndex, page); }
    if (!page.keys) return this.setDense(page, offset, triangle, distance);
    let slot = hash(offset, page.keys.length);
    while (page.keys[slot] && page.keys[slot] !== offset + 1) slot = (slot + 1) & (page.keys.length - 1);
    if (page.keys[slot]) {
      if (distance >= page.distances[slot]) return false;
      page.triangles[slot] = triangle; page.distances[slot] = distance; return true;
    }
    if ((page.count + 1) * 10 > page.keys.length * 7) {
      const capacity = page.keys.length * 2;
      const next = capacity >= PAGE_SIZE
        ? { keys: null, triangles: new Int32Array(PAGE_SIZE).fill(-1), distances: new Float64Array(PAGE_SIZE), count: page.count }
        : makePage(capacity);
      if (next.keys) next.count = page.count;
      for (let i = 0; i < page.keys.length; i++) if (page.keys[i]) {
        const key = page.keys[i] - 1;
        let at = next.keys ? hash(key, capacity) : key;
        if (next.keys) {
          while (next.keys[at]) at = (at + 1) & (capacity - 1);
          next.keys[at] = key + 1;
        }
        next.triangles[at] = page.triangles[i]; next.distances[at] = page.distances[i];
      }
      this.pages.set(pageIndex, next);
      return this.setIfCloser(index, triangle, distance);
    }
    page.keys[slot] = offset + 1; page.triangles[slot] = triangle; page.distances[slot] = distance;
    page.count++; this.size++; return true;
  }
  setDense(page, offset, triangle, distance) {
    if (page.triangles[offset] === -1) { page.count++; this.size++; }
    else if (distance >= page.distances[offset]) return false;
    page.triangles[offset] = triangle; page.distances[offset] = distance; return true;
  }
  forEach(callback) {
    for (const [pageIndex, page] of this.pages) {
      const base = pageIndex * PAGE_SIZE;
      for (let i = 0; i < page.triangles.length; i++) {
        if (page.keys ? page.keys[i] === 0 : page.triangles[i] === -1) continue;
        callback(base + (page.keys ? page.keys[i] - 1 : i), page.triangles[i], page.distances[i]);
      }
    }
  }
  get byteLength() {
    let bytes = 0;
    for (const page of this.pages.values()) bytes += (page.keys?.byteLength ?? 0) + page.triangles.byteLength + page.distances.byteLength;
    return bytes;
  }
}
