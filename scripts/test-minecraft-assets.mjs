import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import mcData from 'minecraft-data';
import { isGravityBlock } from '../src/block-palette.js';
import { MINECRAFT_VERSION, MINECRAFT_DATA_VERSION, BLOCK_REGISTRY_COUNT } from '../src/minecraft-version.js';
const registry = JSON.parse(await readFile(new URL('../public/minecraft-block-registry.json', import.meta.url)));
const atlas = JSON.parse(await readFile(new URL('../public/vanilla.atlas', import.meta.url)));
const report = JSON.parse(await readFile(new URL('../public/minecraft-palette-audit.json', import.meta.url)));
assert.equal(MINECRAFT_VERSION, '26.3'); assert.equal(MINECRAFT_DATA_VERSION, 5023);
assert.equal(registry.blocks.length, BLOCK_REGISTRY_COUNT);
assert.equal(new Set(registry.blocks).size, registry.blocks.length);
assert.equal(atlas.minecraftVersion, MINECRAFT_VERSION);
assert.equal(atlas.dataVersion, MINECRAFT_DATA_VERSION);
const byName = new Map(atlas.blocks.map(block => [block.name, block]));
const directions = ['west', 'east', 'down', 'up', 'north', 'south'];
for (const name of registry.blocks) {
  const info = registry.details[name]; assert.ok(info, name);
  assert.equal(byName.has(name), info.supported, name);
  if (!info.supported) { assert.ok(info.reason, name); continue; }
  assert.ok(info.fullCube && !isGravityBlock(name.slice(10)), name);
  const block = byName.get(name);
  for (const face of directions) {
    assert.ok(atlas.textures[block.faces[face]], `${name} ${face}`);
    const rect = atlas.textures[block.faces[face]];
    assert.ok(rect.atlasColumn >= 0 && rect.atlasColumn < atlas.atlasSize && rect.atlasRow >= 0 && rect.atlasRow < atlas.atlasSize);
  }
  for (const profile of ['balanced', 'top', 'sides']) for (const channel of ['r', 'g', 'b']) {
    assert.ok(Number.isFinite(block.colours[profile][channel]) && block.colours[profile][channel] >= 0 && block.colours[profile][channel] <= 1, `${name} ${profile}`);
  }
}
assert.equal(byName.size, report.supportedCubes);
assert.equal(registry.blocks.filter(name => registry.details[name].supported && registry.details[name].opaque).length, report.opaqueNonGravityCubes);
for (const name of ['grass_block', 'podzol', 'quartz_block', 'furnace', 'basalt', 'oak_wood', 'poplar_planks', 'poplar_log', 'shulker_box', 'white_shulker_box']) {
  assert.ok(registry.details[`minecraft:${name}`]?.supported, name);
}
for (const name of ['sand', 'red_sand', 'gravel', 'white_concrete_powder', 'white_wool_stairs', 'white_concrete_slab', 'air']) {
  assert.equal(registry.details[`minecraft:${name}`]?.supported, false, name);
}
assert.notEqual(byName.get('minecraft:grass_block').faces.up, byName.get('minecraft:grass_block').faces.down);
assert.ok(byName.get('minecraft:grass_block').colours.top.g > byName.get('minecraft:grass_block').colours.sides.g);
assert.notEqual(byName.get('minecraft:oak_log').faces.up, byName.get('minecraft:oak_log').faces.north);
// Every opaque full default-state cube in the previous audited version must
// still be present; this catches regressions in model-parent/alias resolution.
const previous = mcData('1.20'); let checked = 0;
for (const block of previous.blocksArray) {
  let shape = previous.blockCollisionShapes.blocks[block.name];
  shape = Array.isArray(shape) ? shape[block.defaultState - block.minStateId] : shape;
  if (block.transparent || isGravityBlock(block.name) || JSON.stringify(previous.blockCollisionShapes.shapes[shape]) !== '[[0,0,0,1,1,1]]') continue;
  const info = registry.details[`minecraft:${block.name}`];
  assert.ok(info?.supported && info.opaque, block.name); checked++;
}
assert.equal(checked, 319);
console.log(`Minecraft ${MINECRAFT_VERSION}: ${registry.blocks.length} registry IDs, ${byName.size} textured cubes, ${report.opaqueNonGravityCubes} opaque solids; all 319 previously audited solid cubes covered; face/profile/atlas/version/exclusion checks passed.`);
