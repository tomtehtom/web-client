import { resolveEarthTileUrl } from './config.js';

const EARTH_A = 6378137.0;
const EARTH_F = 1 / 298.257223563;
const EARTH_E2 = EARTH_F * (2 - EARTH_F);
const RAD2DEG = 180 / Math.PI;
const MAX_TILE_RESULTS = Number.POSITIVE_INFINITY;

function cartesianFromDegrees(lonDeg, latDeg, height = 0) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N = EARTH_A / Math.sqrt(1 - EARTH_E2 * sinLat * sinLat);
  const x = (N + height) * cosLat * Math.cos(lon);
  const y = (N + height) * cosLat * Math.sin(lon);
  const z = (N * (1 - EARTH_E2) + height) * sinLat;
  return [x, y, z];
}

class Sphere {
  constructor(center, radius) {
    this.center = center;
    this.radius = Math.max(0, radius || 0);
  }

  intersects(other) {
    if (!other) return true;
    const dx = other.center[0] - this.center[0];
    const dy = other.center[1] - this.center[1];
    const dz = other.center[2] - this.center[2];
    const dist = Math.hypot(dx, dy, dz);
    return dist <= (this.radius + other.radius);
  }
}

function distance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.hypot(dx, dy, dz);
}

function obbToSphere(boxSpec) {
  if (!Array.isArray(boxSpec) || boxSpec.length < 12) return null;
  const cx = boxSpec[0], cy = boxSpec[1], cz = boxSpec[2];
  const h1 = [boxSpec[3], boxSpec[4], boxSpec[5]];
  const h2 = [boxSpec[6], boxSpec[7], boxSpec[8]];
  const h3 = [boxSpec[9], boxSpec[10], boxSpec[11]];
  const corners = [];
  for (let i = 0; i < 8; i++) {
    const s1 = (i & 1) ? 1 : -1;
    const s2 = (i & 2) ? 1 : -1;
    const s3 = (i & 4) ? 1 : -1;
    corners.push([
      cx + s1 * h1[0] + s2 * h2[0] + s3 * h3[0],
      cy + s1 * h1[1] + s2 * h2[1] + s3 * h3[1],
      cz + s1 * h1[2] + s2 * h2[2] + s3 * h3[2],
    ]);
  }
  let minX = corners[0][0], maxX = corners[0][0];
  let minY = corners[0][1], maxY = corners[0][1];
  let minZ = corners[0][2], maxZ = corners[0][2];
  for (const [x, y, z] of corners) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const midX = 0.5 * (minX + maxX);
  const midY = 0.5 * (minY + maxY);
  const midZ = 0.5 * (minZ + maxZ);
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  const radius = 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz);
  return new Sphere([midX, midY, midZ], radius);
}

function regionToSphere(region) {
  if (!Array.isArray(region) || region.length < 6) return null;
  const west = region[0], south = region[1], east = region[2], north = region[3];
  const minH = region[4] || 0;
  const maxH = region[5] || 0;
  const centerLon = ((west + east) * 0.5) * RAD2DEG;
  const centerLat = ((south + north) * 0.5) * RAD2DEG;
  const center = cartesianFromDegrees(centerLon, centerLat, (minH + maxH) * 0.5);
  let radius = 0;
  const lonVals = [west, east];
  const latVals = [south, north];
  for (const lonRad of lonVals) {
    for (const latRad of latVals) {
      const corner = cartesianFromDegrees(lonRad * RAD2DEG, latRad * RAD2DEG, maxH);
      radius = Math.max(radius, distance(center, corner));
    }
  }
  return new Sphere(center, radius || Math.abs(maxH - minH));
}

function boundingVolumeToSphere(volume) {
  if (!volume) return null;
  if (volume.sphere && Array.isArray(volume.sphere)) {
    const [x, y, z, r] = volume.sphere;
    return new Sphere([x, y, z], Math.abs(r || 0));
  }
  if (volume.box) return obbToSphere(volume.box);
  if (volume.region) return regionToSphere(volume.region);
  return null;
}

export class SingleSceneFetcher {
  constructor({ concurrency = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches ? 3 : 6, progressIntervalMs = 2000 } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.progressIntervalMs = progressIntervalMs;
  }

  async fetch3DTiles(lat, lng, zoom, targetScreenSpaceError, apiKey, logFn, radiusMeters, rootUrlString) {
    const radius = Math.max(50, Number.isFinite(radiusMeters) ? radiusMeters : 500);
    const centerECEF = cartesianFromDegrees(lng, lat, 0);
    const regionSphere = new Sphere(centerECEF, radius);
    // A root request starts a loading session. Child URLs carry its identifier;
    // borrowing the map's session here makes the root endpoint return HTTP 400.
    for (let attempt = 0; attempt < 2; attempt++) {
      let active = 0;
      const waiters = [];
      const controller = new AbortController();
      const started = performance.now();
      const stats = { completed: 0, nodes: 0, models: new Set() };
      const report = () => logFn?.(`Discovering tiles: ${stats.completed} tileset requests complete; ${active} active, ${waiters.length} queued; ${stats.nodes} nodes checked; ${stats.models.size} model tiles found; ${((performance.now() - started) / 1000).toFixed(1)}s elapsed`);
      const sessionRef = { signal: controller.signal, visited: new Set(), limit: async fn => {
        if (active >= this.concurrency) await new Promise(resolve => waiters.push(resolve));
        else active++;
        try { controller.signal.throwIfAborted(); return await fn(); }
        finally { stats.completed++; if (waiters.length) waiters.shift()(); else active--; }
      }, stats };
      const urls = [];
      const rootUrl = rootUrlString ? new URL(rootUrlString) : new URL('https://tile.googleapis.com/v1/3dtiles/root.json');

      // Only append key for Google host
      if (rootUrl.hostname === 'tile.googleapis.com' && apiKey && !rootUrl.searchParams.has('key')) {
        rootUrl.searchParams.set('key', apiKey);
      }

      rootUrl.searchParams.delete('session');

      logFn?.(`Discovering source tiles within ${radius.toFixed(0)} m, ${targetScreenSpaceError === 0 ? 'highest available detail' : `geometric error threshold ${targetScreenSpaceError} m`}`);
      const heartbeat = logFn ? setInterval(report, this.progressIntervalMs) : null;

      try {
        await this._walkTileset(rootUrl, regionSphere, apiKey, sessionRef, targetScreenSpaceError, urls, logFn, 0);
        report();
      } catch (error) {
        controller.abort();
        if (error.status === 400 && attempt === 0) {
          logFn?.('Refreshing the tile session…');
          continue;
        }
        throw error;
      } finally { clearInterval(heartbeat); }
      logFn?.(`Found ${stats.models.size} model tile(s) in ${((performance.now() - started) / 1000).toFixed(1)}s. Starting model downloads/decoding next.`);
      return [...new Set(urls)];
    }
  }

  async _walkTileset(url, regionSphere, apiKey, sessionRef, targetSSE, urls, logFn, depth) {
    if (!url || urls.length >= MAX_TILE_RESULTS) return;
    const urlStr = url.toString();
    if (sessionRef.visited.has(urlStr)) return;
    sessionRef.visited.add(urlStr);

    const urlObj = url instanceof URL ? new URL(url) : new URL(String(url));
    if (urlObj.hostname === 'tile.googleapis.com' && apiKey && !urlObj.searchParams.has('key')) urlObj.searchParams.set('key', apiKey);

    let resp, json;
    try {
      const loaded = await sessionRef.limit(async () => {
        const response = await fetch(urlObj.toString(), { cache: depth === 0 ? 'reload' : 'default', signal: sessionRef.signal });
        return { response, json: response.ok ? await response.json() : null };
      });
      resp = loaded.response; json = loaded.json;
    } catch (err) {
      if (sessionRef.signal.aborted) throw err;
      throw new Error(`Could not reach the tile server (${urlObj.pathname}). Please try again.`, { cause: err });
    }
    if (!resp.ok) {
      const error = new Error(`Tile server returned HTTP ${resp.status} for ${urlObj.pathname}. Please try again${[401, 403].includes(resp.status) ? ' or check your API key' : ''}.`);
      error.status = resp.status;
      throw error;
    }
    if (!json?.root) throw new Error('The tile server returned an invalid tileset. Please try again.');
    await this._walkNode(json.root, urlObj, regionSphere, apiKey, sessionRef, targetSSE, urls, logFn, depth);
  }

  async _walkNode(node, baseUrl, regionSphere, apiKey, sessionRef, targetSSE, urls, logFn, depth) {
    if (!node || urls.length >= MAX_TILE_RESULTS) return;
    sessionRef.stats.nodes++;
    const boundingSphere = boundingVolumeToSphere(node.boundingVolume);
    if (boundingSphere && !regionSphere.intersects(boundingSphere)) return;

    const error = Number.isFinite(node.geometricError) ? node.geometricError : 0;
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const shouldRefine = hasChildren && (targetSSE === 0 || error > targetSSE);

    if (shouldRefine) {
      const branches = await Promise.all(node.children.map(async child => {
        const found = [];
        await this._walkNode(child, baseUrl, regionSphere, apiKey, sessionRef, targetSSE, found, logFn, depth + 1);
        return found;
      }));
      for (const found of branches) urls.push(...found);
      return;
    }

    const contents = this._gatherContents(node);
    if (!contents.length && hasChildren) {
      const branches = await Promise.all(node.children.map(async child => {
        const found = [];
        await this._walkNode(child, baseUrl, regionSphere, apiKey, sessionRef, targetSSE, found, logFn, depth + 1);
        return found;
      }));
      for (const found of branches) urls.push(...found);
      return;
    }

    for (const content of contents) {
      if (urls.length >= MAX_TILE_RESULTS) break;
      await this._handleContent(content, baseUrl, regionSphere, apiKey, sessionRef, targetSSE, urls, logFn, depth);
    }
  }

  _gatherContents(node) {
    const contents = [];
    if (node?.content?.uri) contents.push(node.content);
    if (Array.isArray(node?.contents)) contents.push(...node.contents);
    const gltfExt = node?.extensions?.['3DTILES_content_gltf'];
    if (gltfExt) {
      if (Array.isArray(gltfExt.contents)) contents.push(...gltfExt.contents);
      else if (gltfExt.content) contents.push(gltfExt.content);
      else if (gltfExt.uri) contents.push({ uri: gltfExt.uri, type: gltfExt.mimeType || gltfExt.type });
    }
    return contents;
  }

  async _handleContent(content, baseUrl, regionSphere, apiKey, sessionRef, targetSSE, urls, logFn, depth) {
    if (!content?.uri || urls.length >= MAX_TILE_RESULTS) return;
    let contentURL;
    try {
      contentURL = resolveEarthTileUrl(content.uri, baseUrl);
    } catch (e) {
      logFn?.(`Bad content URI ${content.uri}`);
      return;
    }
    if (contentURL.hostname === 'tile.googleapis.com' && apiKey && !contentURL.searchParams.has('key')) contentURL.searchParams.set('key', apiKey);
    if (contentURL.origin === baseUrl.origin && !contentURL.searchParams.has('session') && baseUrl.searchParams.has('session')) {
      contentURL.searchParams.set('session', baseUrl.searchParams.get('session'));
    }

    const href = contentURL.toString();
    const mime = (content.type || content.mimeType || content.contentType || '').toLowerCase();
    const pathLower = (contentURL.pathname || '').toLowerCase();
    const isJson = pathLower.endsWith('.json') || mime.includes('json');
    const isGltf = pathLower.endsWith('.glb') || pathLower.endsWith('.gltf') || mime.includes('gltf');

    if (isJson) {
      if (depth < 32) {
        await this._walkTileset(contentURL, regionSphere, apiKey, sessionRef, targetSSE, urls, logFn, depth + 1);
      }
      return;
    }

    if (isGltf) {
      urls.push(href);
      sessionRef.stats.models.add(href);
      return;
    }

    logFn?.(`Skipping non-GLB content (${content.type || 'unknown'}): ${href}`);
  }

}
