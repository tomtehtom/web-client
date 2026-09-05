import assert from 'node:assert/strict';
import { SingleSceneFetcher } from '../src/SingleSceneFetcher.js';

const realFetch = globalThis.fetch;
const previousSession = globalThis.__photorealSession;
const json = root => new Response(JSON.stringify({ root }));
const capture = fetcher => fetcher.fetch3DTiles(0, 0, null, 20, '', null, 100, 'https://example.org/root.json?session=stale');
try {
  globalThis.__photorealSession = { id: 'other-map-session', ts: Date.now() };
  let roots = 0;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith('root.json')) {
      assert.equal(url.searchParams.has('session'), false, 'Root requests must not reuse any loading session');
      assert.equal(options.cache, 'reload', 'A new capture must refresh its root document');
      roots++;
      return json({ geometricError: 100, children: [
        { content: { uri: `a.json?session=a${roots}` } },
        { content: { uri: `b.json?session=b${roots}` } },
      ] });
    }
    const branch = url.pathname.slice(1, 2);
    assert.equal(url.searchParams.get('session'), `${branch}${roots}`, 'Parallel branches retain their own URI session');
    if (roots === 1 && branch === 'b') return new Response('', { status: 400 });
    return json({ content: { uri: `${branch}.glb` } });
  };
  const fetcher = new SingleSceneFetcher({ concurrency: 2 });
  assert.deepEqual(await capture(fetcher), ['https://example.org/a.glb?session=a2', 'https://example.org/b.glb?session=b2']);
  assert.equal(roots, 2, 'Rejected child requests restart discovery from a fresh root');
  assert.deepEqual(await capture(fetcher), ['https://example.org/a.glb?session=a3', 'https://example.org/b.glb?session=b3']);
  assert.equal(globalThis.__photorealSession.id, 'other-map-session', 'Capture must not mutate the map session');
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; return new Response('', { status: 400 }); };
  await assert.rejects(capture(fetcher), /HTTP 400/);
  assert.equal(attempts, 2, 'Persistent rejection must stop after one refresh');
  globalThis.fetch = async () => new Response('', { status: 403 });
  await assert.rejects(capture(fetcher), /HTTP 403.*API key/, 'Failures must not be reported as an empty location');
} finally {
  globalThis.fetch = realFetch;
  globalThis.__photorealSession = previousSession;
}
console.log('Single Scene sessions: clean roots, branch isolation, repeat capture, bounded refresh and errors passed.');
