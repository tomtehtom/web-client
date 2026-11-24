import assert from 'node:assert/strict';
import { SparseVoxelHits } from '../src/voxel-hit-store.js';

const store = new SparseVoxelHits(), reference = new Map();
let seed=42;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
for(let n=0;n<40000;n++) {
  const index=n%7===0 ? 2**40+random()%10000 : random()%12000;
  const distance=(random()%10000)/1000, triangle=n%100;
  const previous=reference.get(index), shouldChange=!previous || distance<previous.distance;
  assert.equal(store.setIfCloser(index,triangle,distance),shouldChange);
  if(shouldChange)reference.set(index,{triangle,distance});
}
const actual=new Map();
store.forEach((index,triangle,distance)=>actual.set(index,{triangle,distance}));
assert.deepEqual(actual,reference,'Sparse/dense page promotion must preserve exact closest hits and wide indices');
assert.equal(store.size,reference.size);
const tied=new SparseVoxelHits();
assert.ok(tied.setIfCloser(0,0,1.00000001));
assert.ok(!tied.setIfCloser(0,3,1.00000001));
assert.ok(tied.setIfCloser(0,2,1.000000005));
tied.forEach((index,triangle,distance)=>{assert.equal(index,0);assert.equal(triangle,2);assert.equal(distance,1.000000005);});

// Exceed the 2^24 unique-entry boundary of the old single V8 Map. The directory
// must contain only pages, with no JS object allocation per voxel.
const large=new SparseVoxelHits(), count=2**24+1025;
for(let i=0;i<count;i++)large.setIfCloser(i,i%127,i%31);
assert.equal(large.size,count);
assert.ok(large.pages.size<20000);
assert.ok(large.byteLength<count*13);
let visited=0;
large.forEach((index,triangle,distance)=>{
  assert.equal(triangle,index%127);assert.equal(distance,index%31);visited++;
});
assert.equal(visited,count);
assert.ok(large.setIfCloser(count-1,900,0));
assert.equal(large.size,count);
console.log(`Voxel hits: ${count.toLocaleString()} occupied cells exceed the old Map entry ceiling; ${(large.byteLength/1048576).toFixed(1)} MiB typed buffers, ${large.pages.size} directory entries; random closest-hit oracle, ties, page growth and wide indices passed.`);
