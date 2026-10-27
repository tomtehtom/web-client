import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import nbt from 'prismarine-nbt';
import { bitCount, bestShapeMasks, fitHalfBlockGrid } from '../src/shape-fitting.js';
import { setExportBlockPalette, rgbToOKLab, buildBlockGrid } from '../src/assignToBlocksForGLB.js';
import { writeCombinedSchematic } from '../src/combined-schematic.js';
import { writeStructureGrid } from '../src/structure-export.js';
import { partitionSparseGrid } from '../src/tiled-export.js';
import { MINECRAFT_DATA_VERSION } from '../src/minecraft-version.js';

const { materials } = JSON.parse(await readFile(new URL('../public/minecraft-shapes.json', import.meta.url)));
assert.equal(materials.length, 198);
const names = new Set(materials.map(material => material.name));
for (const name of ['oak_stairs', 'poplar_stairs', 'stone_slab', 'quartz_stairs', 'cut_copper_slab']) assert.ok(names.has(name), name);
for (const material of materials) for (const variant of material.variants) {
  const expected = material.name.endsWith('_slab') ? 4 : variant.state.includes('inner_') ? 7 : variant.state.includes('outer_') ? 5 : 6;
  assert.equal(bitCount(variant.mask), expected, variant.state);
  assert.ok(variant.state.includes('waterlogged=false'));
}
const slab = materials.find(material => material.name === 'stone_slab');
assert.equal(slab.variants.find(v => v.state.includes('type=bottom')).mask, 0x33);
assert.equal(slab.variants.find(v => v.state.includes('type=top')).mask, 0xcc);
const stairs = materials.find(material => material.name === 'oak_stairs');
// Independent geometric oracle: an east-facing stair rises in +X; north in -Z.
for (const half of ['bottom', 'top']) for (const facing of ['east', 'west', 'north', 'south']) {
  let mask = 0;
  for (let x=0;x<2;x++) for (let y=0;y<2;y++) for (let z=0;z<2;z++) {
    const base = y === (half === 'bottom' ? 0 : 1);
    const raised = facing === 'east' ? x === 1 : facing === 'west' ? x === 0 : facing === 'north' ? z === 0 : z === 1;
    if (base || raised) mask |= 1 << (x+2*y+4*z);
  }
  assert.equal(stairs.variants.find(v => v.state.includes(`facing=${facing},half=${half},shape=straight`)).mask, mask);
}
const colour = slab.colours.balanced;
setExportBlockPalette([{ name: 'stone', oklab: rgbToOKLab(colour.r, colour.g, colour.b) }]);
const source = masks => {
  const nx = masks.length * 6, ny = 2, indices = [], colors = [];
  for (let cell=0;cell<masks.length;cell++) for (let bit=0;bit<8;bit++) if (masks[cell] & 1<<bit) {
    const x = cell*6+(bit&1), y=(bit>>1)&1, z=(bit>>2)&1;
    indices.push(x+nx*(y+ny*z)); colors.push(0xff808080);
  }
  return { gridSize:{x:nx,y:ny,z:2}, unit:{x:.5,y:.5,z:.5}, bbox:{min:[0,0,0],max:[nx*.5,1,1]},
    sparse:{indices:Float64Array.from(indices),colors:Uint32Array.from(colors)},
    exportMetadata:{shapeSampling:2,metersPerBlock:1,rotationDegrees:15} };
};
const masks = Array.from({length:255},(_,i)=>i+1);
const original = source(masks), copy = structuredClone(original);
const fitted = fitHalfBlockGrid(original, materials);
assert.deepEqual(original, copy, 'Fitting must preserve the preview source');
assert.equal(fitted.unit.x, 1); assert.equal(fitted.gridSize.y, 1);
assert.equal(fitted.exportMetadata.metersPerBlock, 1);
const states = new Map(materials.flatMap(m=>m.variants.map(v=>[v.state,v.mask])));
states.set('stone',255);
const available = [...new Set(states.values())];
for (let i=0;i<masks.length;i++) {
  const state = fitted.fittedStates.palette[fitted.fittedStates.ids[i]];
  const actual = states.get(state), error = bitCount(actual ^ masks[i]);
  assert.equal(error, Math.min(...available.map(mask=>bitCount(mask ^ masks[i]))));
  if (available.includes(masks[i])) assert.equal(actual,masks[i], 'Every representable orientation must be exact');
  assert.ok(bestShapeMasks(masks[i],available).includes(actual));
}
// Same geometry, distinctly different colours must select the matching material.
const testMaterials = [
  {...slab, name:'black',colours:{balanced:{r:0,g:0,b:0}},variants:[{mask:51,state:'blackstone_slab[type=bottom,waterlogged=false]'}]},
  {...slab, name:'white',colours:{balanced:{r:1,g:1,b:1}},variants:[{mask:51,state:'quartz_slab[type=bottom,waterlogged=false]'}]},
];
for (const [packed, expected] of [[0xff000000,'blackstone'],[0xffffffff,'quartz']]) {
  const grid = source([51]); grid.sparse.colors.fill(packed);
  const result=fitHalfBlockGrid(grid,testMaterials);
  assert.ok(result.fittedStates.palette[0].startsWith(expected));
}
const schematic = nbt.simplify((await nbt.parse(Buffer.concat((await writeCombinedSchematic(fitted)).fileParts))).parsed);
assert.equal(schematic.DataVersion,MINECRAFT_DATA_VERSION);
assert.equal(schematic.Height,1);
for (const state of fitted.fittedStates.palette) assert.ok(`minecraft:${state}` in schematic.Palette);
const structure = nbt.simplify((await nbt.parse(Buffer.from(await writeStructureGrid(buildBlockGrid(fitted))))).parsed);
assert.ok(structure.palette.some(entry=>entry.Properties?.half === 'top'));
assert.ok(structure.palette.some(entry=>entry.Properties?.type === 'bottom'));
assert.ok(structure.palette.every(entry=>!entry.Name.includes('[')));
for (const bucket of partitionSparseGrid(fitted).values()) {
  const tile = buildBlockGrid({...fitted,sparse:{indices:bucket.indices,colors:bucket.colors},fittedStates:{palette:fitted.fittedStates.palette,ids:bucket.stateIds}});
  assert.ok(tile.palette.every(state=>fitted.fittedStates.palette.includes(state)));
}
assert.throws(()=>fitHalfBlockGrid({...original,exportMetadata:{}},materials),/Rebuild/);
console.log(`Shape fitting: ${materials.length} materials, 4,082 states; all 255 occupancy masks, independent stair orientation, colour choices, metric scale, stateful NBT/schematic and tile partitions passed.`);
