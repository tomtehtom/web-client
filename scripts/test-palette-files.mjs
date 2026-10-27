import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseBlockPalette, exportBlockCatalog } from '../src/block-palette.js';
import { MINECRAFT_VERSION, BLOCK_REGISTRY_COUNT } from '../src/minecraft-version.js';

const registry = JSON.parse(await readFile(new URL('../public/minecraft-block-registry.json', import.meta.url)));
assert.equal(registry.minecraftVersion, MINECRAFT_VERSION);
assert.equal(new Set(registry.blocks).size, BLOCK_REGISTRY_COUNT);
const catalog = [
  { name: 'minecraft:white_wool', supported: true },
  { name: 'minecraft:stone', supported: true },
  { name: 'minecraft:sand', supported: false, reason: 'Falling block' },
  { name: 'minecraft:oak_door', supported: false, reason: 'No supported texture' },
];
const exported = exportBlockCatalog(catalog, ['white_wool', 'stone', 'sand']);
assert.equal(exported.blocks.length, catalog.length);
assert.equal(exported.blocks.find(block => block.name === 'minecraft:sand').enabled, false);
assert.deepEqual(parseBlockPalette(JSON.stringify(exported), catalog).names, ['minecraft:stone', 'minecraft:white_wool']);
assert.deepEqual(parseBlockPalette('white_wool\nstone\nminecraft:stone', catalog).names, ['minecraft:stone', 'minecraft:white_wool']);
const parsed = parseBlockPalette(JSON.stringify(['stone', 'sand', 'made_up_block']), catalog);
assert.deepEqual(parsed.names, ['minecraft:stone']); assert.equal(parsed.ignored.length, 2);
assert.throws(() => parseBlockPalette('{bad json', catalog), /Invalid palette JSON/);
assert.throws(() => parseBlockPalette(JSON.stringify({ version: 2, blocks: [] }), catalog), /version 1/);
assert.throws(() => parseBlockPalette(JSON.stringify([{ name: 'stone', enabled: 'yes' }]), catalog), /enabled fields/);
assert.throws(() => parseBlockPalette('stone[foo=bar]', catalog), /Invalid block ID/);
assert.throws(() => parseBlockPalette('sand', catalog), /No supported/);
assert.throws(() => parseBlockPalette('[]', catalog), /No supported/);
assert.throws(() => parseBlockPalette(JSON.stringify(Array(10001).fill('stone')), catalog), /10,000/);
const forged = { version: 1, blocks: [{ name: 'minecraft:sand', enabled: true, supported: true }, { name: 'minecraft:stone', enabled: true }] };
assert.deepEqual(parseBlockPalette(JSON.stringify(forged), catalog).names, ['minecraft:stone'], 'Imported support flags must not override the authoritative catalog');
console.log('Palette files: full registry, JSON/text round-trips, duplicates, authoritative exclusions, malformed/empty/version/size validation passed.');
