// Levels share a voxel origin and differ by exact factors of two, including
// non-power-of-two UI caps. This keeps each tile's coarse/fine grids nested.
export function voxelLodLevels(maxResolution, minimum = 8) {
  const cap = Math.max(minimum, Number.isFinite(maxResolution) ? maxResolution : minimum);
  const levels = [cap];
  while (levels[0] / 2 >= minimum) levels.unshift(levels[0] / 2);
  return levels;
}

export function selectVoxelLod(demand, maxResolution, current = null, hysteresis = 0.2) {
  const levels = voxelLodLevels(maxResolution);
  const wanted = Math.max(0, Number.isFinite(demand) ? demand : maxResolution);
  let index = levels.indexOf(current);
  if (index === -1) return levels.find(level => level >= wanted) ?? levels.at(-1);
  // Upgrade only above the current level's upper margin; downgrade only below
  // the next coarser level's lower margin. Camera jitter cannot toggle a level.
  while (index < levels.length - 1 && wanted > levels[index] * (1 + hysteresis)) index++;
  while (index > 0 && wanted < levels[index - 1] * (1 - hysteresis)) index--;
  return levels[index];
}

export function projectedVoxelDemand(span, distance, viewportHeight, fovDegrees, targetPixels = 3) {
  const pixelsPerUnit = viewportHeight / (2 * Math.tan(fovDegrees * Math.PI / 360));
  return Math.max(0, span) * pixelsPerUnit / (Math.max(distance, 1e-3) * targetPixels);
}

// Count retained typed buffers once, including packed atlases and optional
// export grids. Driver objects/framebuffers/source tiles are not included.
export function voxelResultBytes(result) {
  const buffers = new Set();
  const add = array => { if (array?.buffer) buffers.add(array.buffer); };
  const texture = value => { if (!value?.userData?.sharedVoxelResource) add(value?.image?.data); };
  result.voxelMesh?.traverse(node => {
    add(node.geometry?.index?.array);
    for (const attribute of Object.values(node.geometry?.attributes ?? {})) add(attribute.array ?? attribute.data?.array);
    for (const material of [node.material, node.userData?.origMat, node.userData?.mcMat].flat()) {
      if (!material) continue;
      texture(material.map);
      for (const uniform of Object.values(material.uniforms ?? {})) texture(uniform.value);
    }
  });
  const grid = result._voxelGrid;
  add(grid?.voxelColors); add(grid?.voxelCounts);
  add(grid?.sparse?.indices); add(grid?.sparse?.colors);
  for (const chunk of grid?.chunked?.chunks ?? []) { add(chunk.colors); add(chunk.alphas); add(chunk.counts); }
  return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}

// Owns cached results and asynchronous job generations. It never removes the
// visible active representation to make room; inactive levels are LRU-evicted.
// If visible working data alone exceeds the budget, stats report that explicitly.
export class VoxelLodCache {
  constructor({ maxBytes = 128 * 1024 * 1024, maxLevelsPerTile = 3, onActivate, onDispose, measureBytes = voxelResultBytes } = {}) {
    this.maxBytes = maxBytes;
    this.maxLevelsPerTile = maxLevelsPerTile;
    this.onActivate = onActivate;
    this.onDispose = onDispose;
    this.measureBytes = measureBytes;
    this.tiles = new Map();
    this.bytes = 0;
    this.tick = 0;
    this.builds = 0;
    this.hits = 0;
    this.evictions = 0;
  }

  state(tile) {
    let state = this.tiles.get(tile);
    if (!state) {
      state = { levels: new Map(), active: null, pending: null, desired: null, visible: true };
      this.tiles.set(tile, state);
    }
    return state;
  }

  current(tile) { return this.tiles.get(tile)?.active ?? null; }
  pending(tile) { return this.tiles.get(tile)?.pending ?? null; }

  request(tile, resolution, signature, { allowBuild = true } = {}) {
    const state = this.state(tile);
    const key = JSON.stringify([signature, resolution]);
    state.desired = key;
    if (!state.visible) return { status: 'hidden' };
    if (state.pending && state.pending.key !== key) this.cancel(tile);
    if (state.active?.key === key) { state.active.used = ++this.tick; return { status: 'current' }; }
    const cached = state.levels.get(key);
    if (cached) {
      this.hits++;
      this.activate(tile, state, cached);
      return { status: 'cached' };
    }
    if (state.pending) return { status: 'pending' };
    if (!allowBuild) return { status: 'deferred' };
    const token = { tile, key, signature, resolution, controller: null, result: null };
    state.pending = token;
    this.builds++;
    return { status: 'build', token };
  }

  isCurrent(token) {
    const state = this.tiles.get(token.tile);
    return state?.visible && state.pending === token && state.desired === token.key;
  }

  setController(token, controller) {
    if (!this.isCurrent(token)) controller?.terminate?.();
    else token.controller = controller;
  }

  stage(token, result) {
    if (!this.isCurrent(token)) { this.onDispose(result); return false; }
    token.result = result;
    return true;
  }

  commit(token) {
    if (!this.isCurrent(token) || !token.result) return false;
    const state = this.tiles.get(token.tile);
    const entry = { key: token.key, signature: token.signature, resolution: token.resolution,
      result: token.result, bytes: this.measureBytes(token.result), used: ++this.tick };
    token.result = null;
    state.pending = null;
    state.levels.set(entry.key, entry);
    this.bytes += entry.bytes;
    this.activate(token.tile, state, entry);
    return true;
  }

  activate(tile, state, entry) {
    const previous = state.active;
    state.active = entry;
    entry.used = ++this.tick;
    this.onActivate(tile, entry, previous);
    this.trim();
  }

  cancel(tile) {
    const state = this.tiles.get(tile), token = state?.pending;
    if (!token) return;
    state.pending = null; // Invalidate before terminating/rejecting asynchronous work.
    token.controller?.terminate?.();
    if (token.result) { this.onDispose(token.result); token.result = null; }
  }

  fail(token) {
    if (this.tiles.get(token.tile)?.pending === token) this.cancel(token.tile);
  }

  setVisible(tile, visible) {
    const state = this.state(tile);
    if (state.visible === visible) return;
    state.visible = visible;
    if (!visible) this.cancel(tile);
    this.trim();
  }

  evict(state, entry) {
    if (!state.levels.delete(entry.key)) return;
    if (state.active === entry) state.active = null;
    this.bytes -= entry.bytes;
    this.evictions++;
    this.onDispose(entry.result);
  }

  trim() {
    const candidates = [];
    for (const state of this.tiles.values()) {
      const inactive = [...state.levels.values()].filter(entry => entry !== state.active).sort((a, b) => a.used - b.used);
      while (state.levels.size > this.maxLevelsPerTile && inactive.length) this.evict(state, inactive.shift());
      for (const entry of state.levels.values()) {
        if (entry !== state.active || !state.visible) candidates.push({ state, entry });
      }
    }
    candidates.sort((a, b) => a.entry.used - b.entry.used);
    for (const { state, entry } of candidates) {
      if (this.bytes <= this.maxBytes) break;
      this.evict(state, entry);
    }
  }

  // Invalidate settings without punching a hole in the current view.
  invalidate(tile) {
    const state = this.tiles.get(tile);
    if (!state) return;
    this.cancel(tile);
    state.desired = null;
    for (const entry of [...state.levels.values()]) if (entry !== state.active) this.evict(state, entry);
  }

  remove(tile) {
    const state = this.tiles.get(tile);
    if (!state) return;
    this.cancel(tile);
    for (const entry of [...state.levels.values()]) this.evict(state, entry);
    this.tiles.delete(tile);
  }

  clear() { for (const tile of [...this.tiles.keys()]) this.remove(tile); }

  stats() {
    let activeBytes = 0, pending = 0, entries = 0;
    for (const state of this.tiles.values()) {
      if (state.visible && state.active) activeBytes += state.active.bytes;
      if (state.pending) pending++;
      entries += state.levels.size;
    }
    return { bytes: this.bytes, activeBytes, maxBytes: this.maxBytes, overBudgetBytes: Math.max(0, this.bytes - this.maxBytes),
      tiles: this.tiles.size, entries, pending, builds: this.builds, hits: this.hits, evictions: this.evictions };
  }
}
