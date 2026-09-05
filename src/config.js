/**
 * config.js - Centralized configuration for tile server endpoints.
 */

export const TILE_SERVERS = {
    google: (apiKey) => `https://tile.googleapis.com/v1/3dtiles/root.json?key=${apiKey}`,
    local: () => `http://localhost:8787/v1/3dtiles/root.json`,
    custom: () => `https://edu.voxelearth.org/v1/3dtiles/root.json`,
};

// Set the active server here
export const ACTIVE_SERVER = 'custom'; // 'google' | 'local' | 'custom'

// If using 'custom', set this URL
export const CUSTOM_SERVER_URL = '';

export function getActiveServerUrl(apiKey) {
    // If the user provided an API key, always use Google directly
    if (apiKey) {
        return TILE_SERVERS.google(apiKey);
    }
    // No API key → use the configured fallback server
    if (ACTIVE_SERVER === 'custom' && CUSTOM_SERVER_URL) {
        return CUSTOM_SERVER_URL;
    }
    const factory = TILE_SERVERS[ACTIVE_SERVER];
    const url = factory ? factory(apiKey) : TILE_SERVERS.google(apiKey);
    // The shared Earth endpoint does not allow localhost CORS. Vite forwards
    // this same-origin development route; production keeps its configured URL.
    if (import.meta.env?.DEV && ACTIVE_SERVER === 'custom' && !CUSTOM_SERVER_URL) {
        return new URL('/earth-tiles/v1/3dtiles/root.json', window.location.origin).href;
    }
    return url;
}

export function resolveEarthTileUrl(value, root) {
    const url = new URL(value, root);
    const base = new URL(root);
    if (base.pathname.startsWith('/earth-tiles/') && (url.origin === new URL(TILE_SERVERS.custom()).origin
        || (url.origin === base.origin && url.pathname.startsWith('/v1/3dtiles/')))) {
        return new URL('/earth-tiles' + url.pathname + url.search, base.origin);
    }
    return url;
}

export function isLocalServer() {
    return ACTIVE_SERVER === 'local' || (ACTIVE_SERVER === 'custom' && CUSTOM_SERVER_URL.includes('localhost'));
}
