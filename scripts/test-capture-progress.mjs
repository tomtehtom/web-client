import assert from 'node:assert/strict';
import { CaptureProgress, formatRemaining } from '../src/capture-progress.js';
import { SingleSceneFetcher } from '../src/SingleSceneFetcher.js';

assert.equal(formatRemaining(Infinity),'estimating…');
assert.equal(formatRemaining(0), '0s');
assert.equal(formatRemaining(61),'1m 1s');
assert.equal(formatRemaining(4000),'1h 6m');
const progress = new CaptureProgress(0);
assert.equal(progress.estimate(0,100,0).seconds,Infinity);
assert.equal(progress.estimate(20,80,2000).seconds,8);
assert.equal(progress.estimate(40,160,4000).seconds,16,'Discovery ETA must increase when more descendants are found');
assert.equal(progress.estimate(40,160,8000).seconds,32,'Network stalls must increase the estimate');
assert.equal(progress.estimate(200,0,16000).seconds,0);
assert.equal(new SingleSceneFetcher().concurrency,24);
const originalFetch=globalThis.fetch;
try {
  const results=[];
  for (const concurrency of [6,24]) {
    let active=0,peak=0;
    globalThis.fetch=async input=>{
      active++;peak=Math.max(peak,active);
      await new Promise(resolve=>setTimeout(resolve,5));
      active--;
      const path=new URL(input).pathname;
      const root=path==='/root.json' ? {geometricError:100,children:Array.from({length:48},(_,i)=>({content:{uri:`branch-${i}.json`}}))}
        : {content:{uri:path.replace('.json','.glb')}};
      return new Response(JSON.stringify({root}));
    };
    const logs=[],start=performance.now();
    const urls=await new SingleSceneFetcher({concurrency,progressIntervalMs:2}).fetch3DTiles(0,0,null,0,'',line=>logs.push(line),100,'https://example.org/root.json');
    assert.equal(peak,concurrency);
    assert.ok(logs.some(line=>line.includes('discovery ETA')));
    assert.ok(logs.some(line=>line.includes('discovery ETA 0s')));
    results.push({urls:urls.sort(),concurrency,ms:Math.round(performance.now()-start)});
  }
  assert.deepEqual(results[0].urls,results[1].urls,'Parallelism must not change capture detail or model selection');
  console.log(`Capture progress: startup/stalls/growing queue/completion estimates passed; 48-request mock discovery ${results[0].ms} ms at 6 vs ${results[1].ms} ms at 24, identical results.`);
} finally {globalThis.fetch=originalFetch;}
