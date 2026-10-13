// 前瞻峰值限制器：保证每个采样都不超过上限，起控平滑过渡、释放缓慢回升。
export function limit(channels, fs, ceilingDb = -1, { lookaheadMs = 5, releaseMs = 80 } = {}) {
  const ceiling = Math.pow(10, ceilingDb / 20);
  const len = channels[0].length;
  const g = new Float64Array(len);
  let needed = false;
  for (let i = 0; i < len; i++) {
    let p = 0;
    for (const x of channels) p = Math.max(p, Math.abs(x[i]));
    g[i] = p > ceiling ? ceiling / p : 1;
    if (g[i] < 1) needed = true;
  }
  if (!needed) return { channels, reducedDb: 0 };
  const attack = 1 / Math.max(1, Math.round((lookaheadMs / 1000) * fs));
  const release = 1 / Math.max(1, Math.round((releaseMs / 1000) * fs));
  for (let i = len - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] + attack); // 提前线性压下
  for (let i = 1; i < len; i++) g[i] = Math.min(g[i], g[i - 1] + release); // 缓慢释放
  let minG = 1;
  for (let i = 0; i < len; i++) minG = Math.min(minG, g[i]);
  const out = channels.map((x) => {
    const y = new Float32Array(len);
    for (let i = 0; i < len; i++) y[i] = x[i] * g[i];
    return y;
  });
  return { channels: out, reducedDb: 20 * Math.log10(minG) };
}
