export function formatRemaining(seconds) {
  if (!Number.isFinite(seconds)) return 'estimating…';
  const total = Math.max(0, Math.ceil(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor(total % 3600 / 60)}m`;
}

// Use recent completions so the estimate responds to changing network speed.
// Discovery passes only its known queue: more descendants may still be found.
export class CaptureProgress {
  constructor(started = performance.now()) { this.samples = [{ time: started, completed: 0 }]; }
  estimate(completed, remaining, now = performance.now()) {
    this.samples.push({ time: now, completed });
    while (this.samples.length > 2 && this.samples[1].time <= now - 15000) this.samples.shift();
    const first = this.samples[0], elapsed = (now - first.time) / 1000;
    const rate = elapsed > 0 ? (completed - first.completed) / elapsed : 0;
    const seconds = remaining === 0 ? 0 : elapsed >= 1 && rate > 0 ? remaining / rate : Infinity;
    return { rate, text: formatRemaining(seconds), seconds };
  }
}
