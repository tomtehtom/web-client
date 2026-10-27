import { MINECRAFT_VERSION } from './minecraft-version.js';
export const DEFAULT_BLOCK_PALETTE = Object.freeze({ wool: true, concrete: true, terracotta: true, glazed: false, other: false });
export function normalizeBlockPalette(options = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_BLOCK_PALETTE).map(([key, value]) => [key, typeof options[key] === 'boolean' ? options[key] : value]));
}
export function isGravityBlock(name) {
  return /^(sand|red_sand|gravel|suspicious_(sand|gravel)(_[0-3])?|anvil|chipped_anvil|damaged_anvil|dragon_egg|scaffolding|pointed_dripstone)$/.test(name)
    || /_concrete_powder$/.test(name);
}
export function blockAllowedByPalette(name, options = DEFAULT_BLOCK_PALETTE) {
  name = name.replace(/^minecraft:/, '');
  if (isGravityBlock(name)) return false;
  if (/_wool$/.test(name)) return options.wool;
  if (/_concrete$/.test(name)) return options.concrete;
  if (/_glazed_terracotta$/.test(name)) return options.glazed;
  if (name === 'terracotta' || /_terracotta$/.test(name)) return options.terracotta;
  return options.other;
}

export function parseBlockPalette(text, catalog) {
  let input;
  try { input = JSON.parse(text); }
  catch {
    if (/^[\s]*[\[{]/.test(text)) throw new Error('Invalid palette JSON.');
    input = text.split(/[\r\n,]+/).map(name => name.trim()).filter(Boolean);
  }
  if (!Array.isArray(input)) {
    if (!input || input.version !== 1 || !Array.isArray(input.blocks)) throw new Error('Expected a version 1 block-list file, an array of block IDs, or one block ID per line.');
    input = input.blocks;
  }
  if (input.length > 10000) throw new Error('Block list exceeds 10,000 entries.');
  const byName = new Map(catalog.map(block => [block.name, block]));
  const names = new Set(), ignored = [];
  for (const entry of input) {
    if (typeof entry !== 'string' && (!entry || typeof entry.name !== 'string' || typeof entry.enabled !== 'boolean')) {
      throw new Error('Each entry must be a block ID or an object with name and enabled fields.');
    }
    if (typeof entry !== 'string' && !entry.enabled) continue;
    let name = (typeof entry === 'string' ? entry : entry.name).trim();
    if (!name.includes(':')) name = `minecraft:${name}`;
    if (!/^minecraft:[a-z0-9_]+$/.test(name)) throw new Error(`Invalid block ID: ${name.slice(0, 80)}. Use block names without state properties.`);
    const block = byName.get(name);
    if (!block?.supported) { ignored.push({ name, reason: block?.reason ?? 'Unknown block ID for this catalog' }); continue; }
    names.add(name);
  }
  if (!names.size) throw new Error('No supported, enabled blocks remain in this list. The current palette was kept.');
  return { names: [...names].sort(), ignored };
}

export function exportBlockCatalog(catalog, enabledNames) {
  const enabled = new Set(enabledNames.map(name => name.startsWith('minecraft:') ? name : `minecraft:${name}`));
  return { type: 'voxel-earth-block-palette', version: 1, minecraftVersion: MINECRAFT_VERSION,
    blocks: catalog.map(block => ({ ...block, enabled: block.supported && enabled.has(block.name) })) };
}
