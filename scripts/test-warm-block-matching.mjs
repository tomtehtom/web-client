import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rgbToOKLab,setExportBlockPalette,createExportBlockMatcher } from '../src/assignToBlocksForGLB.js';
import { blockAllowedByPalette } from '../src/block-palette.js';
const atlas=JSON.parse(await readFile(new URL('../public/vanilla.atlas',import.meta.url)));
const blocks=atlas.blocks.filter(b=>blockAllowedByPalette(b.name)).map(b=>({name:b.name,oklab:rgbToOKLab(b.colours.balanced.r,b.colours.balanced.g,b.colours.balanced.b),rgb:b.colours.balanced}));
const warm=[[210,140,120],[220,145,120]];
setExportBlockPalette(blocks,0,'accurate',1);
const balanced=createExportBlockMatcher({});
assert.ok(warm.every(rgb=>balanced(...rgb.map(c=>c/255)).includes('pink_wool')),'Reproduce warm source colours choosing pink with the original metric');
setExportBlockPalette(blocks,0,'accurate',2);
const hue=createExportBlockMatcher({});
assert.ok(warm.every(rgb=>hue(...rgb.map(c=>c/255))==='minecraft:white_terracotta'));
for(const block of blocks)assert.equal(hue(block.rgb.r,block.rgb.g,block.rgb.b),block.name,'Exact source colours must still select their own block, including real pinks');
for(const weight of [1,2]) {
  setExportBlockPalette(blocks,0,'accurate',weight);const match=createExportBlockMatcher({});
  for(let i=0;i<1000;i++) {
    const rgb=[(i*37%256)/255,(i*71%256)/255,(i*113%256)/255],q=rgbToOKLab(...rgb);
    const expected=blocks.map(b=>({name:b.name,d:(q.L-b.oklab.L)**2+weight*((q.a-b.oklab.a)**2+(q.b-b.oklab.b)**2)})).sort((a,b)=>a.d-b.d)[0];
    assert.equal(match(...rgb),expected.name,'Weighted KD search must agree with an independent exhaustive oracle');
  }
}
console.log('Full-block warm colours: original pink-wool regression reproduced, hue priority chooses terracotta; exact block self-matches and 2,000 independent weighted KD comparisons passed.');
