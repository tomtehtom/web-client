// Bounded retries for transient tile-network failures. Never retry an aborted
// request or authentication/rate-limit responses here (session recovery is separate).
export async function fetchEarthResource(input, options, fetchImpl, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const method = (options?.method ?? input?.method ?? 'GET').toUpperCase();
  const signal = options?.signal ?? input?.signal;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    try {
      const response = await fetchImpl(input, options);
      if (attempt >= 2 || !['GET', 'HEAD'].includes(method) || ![500, 502, 503, 504].includes(response.status)) return response;
      await response.body?.cancel();
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || attempt >= 2 || !['GET', 'HEAD'].includes(method)) throw error;
    }
    await wait(attempt === 0 ? 300 : 900);
  }
}
