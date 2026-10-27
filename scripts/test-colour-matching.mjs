import assert from 'node:assert/strict';
import { setExportBlockPalette, createExportBlockMatcher } from '../src/assignToBlocksForGLB.js';

// Independent reference conversion builds known test palette colours. Close
// colours share a 5-6-5 bin, so bin-centre matching cannot reliably self-match.
function lab([r, g, b]) {
  [r, g, b] = [r, g, b].map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return { L: .2104542553 * l + .793617785 * m - .0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
    b: .0259040371 * l + .7827717662 * m - .808675766 * s };
}
const rgb = [[.5, .5, .5], [.51, .5, .5], [.5, .51, .5], [.5, .5, .51]];
const blocks = rgb.map((value, i) => ({ name: `colour_${i}`, oklab: lab(value) }));
setExportBlockPalette(blocks, 0, 'fast');
const fast = createExportBlockMatcher({ blockMatching: 'packed' });
assert.ok(rgb.some((value, i) => fast(...value) !== blocks[i].name), 'Fixture must demonstrate the bin-centre matching error');
setExportBlockPalette(blocks, 0, 'accurate');
for (const packed of [false, true]) {
  const match = createExportBlockMatcher(packed ? { blockMatching: 'packed' } : {});
  for (const i of [3, 0, 2, 1, 0, 3]) assert.equal(match(...rgb[i]), blocks[i].name, 'Exact colours in the same coarse bin must each pick their own block');
  for (let at = 0; at < 100; at++) {
    const colour = [.49 + (at % 11) * .003, .49 + (at % 7) * .004, .49 + (at % 5) * .005];
    const q = lab(colour);
    const nearest = blocks.map(block => ({ name: block.name, distance: (block.oklab.L - q.L) ** 2 + (block.oklab.a - q.a) ** 2 + (block.oklab.b - q.b) ** 2 })).sort((a, b) => a.distance - b.distance)[0];
    assert.equal(match(...colour), nearest.name);
  }
}
console.log('Colour matching: reproduced coarse-bin error; exact self-matches and independent nearest-OKLab oracle pass, independent of query order.');
