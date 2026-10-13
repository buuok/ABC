// ITU-R BS.1770-4 / EBU R128 积分响度（LUFS）及简单的盲估信噪比。
import { filter } from './biquad.mjs';

// K 加权：高架滤波（头部效应）+ RLB 高通。按采样率重新推导系数（Brecht De Man 的方法），
// 48 kHz 下与 BS.1770 标准系数表一致。
function kWeighting(fs) {
  let K = Math.tan((Math.PI * 1681.974450955533) / fs);
  let Q = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0,
  };
  K = Math.tan((Math.PI * 38.13547087602444) / fs);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

export function integratedLoudness(channels, fs) {
  const [shelf, hp] = kWeighting(fs);
  const len = channels[0].length;
  const block = Math.round(0.4 * fs);
  const step = Math.round(0.1 * fs);
  // 各声道 K 加权平方的前缀和，便于快速求每个 400 ms 块的均方。
  const cum = new Float64Array(len + 1);
  for (const x of channels) {
    const y = filter(filter(x, shelf), hp);
    let acc = 0;
    for (let i = 0; i < len; i++) { acc += y[i] * y[i]; cum[i + 1] += acc; }
  }
  const blocks = [];
  if (len < block) blocks.push(cum[len] / Math.max(len, 1));
  for (let s = 0; s + block <= len; s += step) blocks.push((cum[s + block] - cum[s]) / block);
  const lufs = (z) => -0.691 + 10 * Math.log10(z);
  const aboveAbs = blocks.filter((z) => lufs(z) > -70);
  if (!aboveAbs.length) return -Infinity;
  const mean = (a) => a.reduce((p, v) => p + v, 0) / a.length;
  const relGate = lufs(mean(aboveAbs)) - 10;
  const gated = aboveAbs.filter((z) => lufs(z) > relGate);
  return lufs(mean(gated));
}

export function samplePeakDb(channels) {
  let peak = 0;
  for (const x of channels) for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  return 20 * Math.log10(peak || 1e-12);
}

// 盲估信噪比：50 ms 帧能量的第 90 百分位（语音）减第 10 百分位（底噪）。
export function estimateSnrDb(channels, fs) {
  const n = Math.round(0.05 * fs);
  const levels = [];
  for (let s = 0; s + n <= channels[0].length; s += n) {
    let e = 0;
    for (const x of channels) for (let i = s; i < s + n; i++) e += x[i] * x[i];
    levels.push(10 * Math.log10(e / (n * channels.length) + 1e-20));
  }
  if (levels.length < 10) return NaN;
  levels.sort((a, b) => a - b);
  const pct = (p) => levels[Math.floor(p * (levels.length - 1))];
  return pct(0.9) - pct(0.1);
}

export function applyGain(channels, gainDb) {
  const g = Math.pow(10, gainDb / 20);
  return channels.map((x) => x.map((v) => v * g));
}
