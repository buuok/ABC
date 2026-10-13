// 分段：在停顿处切开一段长音频，用于“已经拼好的视频里，各句音色不一致”的情况。
export function splitAtPauses(channels, fs, { minPause = 0.5, minSegment = 3 } = {}) {
  const len = channels[0].length;
  const n = Math.round(0.02 * fs);
  const levels = [];
  for (let s = 0; s + n <= len; s += n) {
    let e = 0;
    for (const x of channels) for (let i = s; i < s + n; i++) e += x[i] * x[i];
    levels.push(10 * Math.log10(e / (n * channels.length) + 1e-20));
  }
  if (levels.length < 10) return [0, len];
  const sorted = [...levels].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(0.1 * (sorted.length - 1))];
  const p90 = sorted[Math.floor(0.9 * (sorted.length - 1))];
  const threshold = Math.max(p10 + 10, p90 - 35);
  const candidates = [];
  let runStart = -1;
  for (let f = 0; f <= levels.length; f++) {
    const quiet = f < levels.length && levels[f] < threshold;
    if (quiet && runStart < 0) runStart = f;
    if (!quiet && runStart >= 0) {
      if ((f - runStart) * n >= minPause * fs && runStart > 0 && f < levels.length) candidates.push(Math.round(((runStart + f) / 2) * n));
      runStart = -1;
    }
  }
  const cuts = [0];
  for (const c of candidates) {
    if (c - cuts[cuts.length - 1] >= minSegment * fs && len - c >= minSegment * fs) cuts.push(c);
  }
  cuts.push(len);
  return cuts;
}
