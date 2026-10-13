// 去混响：按指数衰减模型估计“晚期混响”的功率谱（Lebart 方法），再像降噪一样逐帧压掉。
// 只削弱说话停顿处拖出来的尾巴，直达声基本不动。
import { frameSizeFor, processFrames } from './stft.mjs';
import { design, filter } from './biquad.mjs';

// 尾音长度：500 Hz–4 kHz 频段里，一句话停下后电平下降 20 dB 用了多少毫秒（取中位数）。
// 直观但样本少时波动较大，所以和 estimateT60 一起用。
export function decayTimeMs(channels, fs) {
  let y = filter(channels[0], design('highpass', fs, 500));
  y = filter(y, design('lowpass', fs, 4000));
  const n = Math.round(0.005 * fs);
  const lv = [];
  for (let s = 0; s + n <= y.length; s += n) {
    let e = 0;
    for (let i = s; i < s + n; i++) e += y[i] * y[i];
    lv.push(10 * Math.log10(e / n + 1e-20));
  }
  const sorted = [...lv].sort((a, b) => a - b);
  const loud = sorted[Math.floor(0.95 * (sorted.length - 1))] - 12;
  const times = [];
  for (let i = 1; i + 80 < lv.length; i++) {
    if (lv[i] < loud || lv[i] < lv[i - 1] || lv[i] < lv[i + 1]) continue;
    let j = i;
    while (j < i + 80 && lv[j] > lv[i] - 30) j++; // 400 ms 内要掉 30 dB，才算停顿前的最后一个音
    if (j >= i + 80) continue;
    let k = i;
    while (lv[k] > lv[i] - 20) k++;
    times.push((k - i) * 5);
    i = j;
  }
  if (times.length < 3) return NaN;
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

// 盲估混响时间（秒）：在三个子频带（0.5–1、1–2、2–4 kHz）的 5 ms 电平曲线里，找所有“持续下降”的片段
// （至少 40 ms、累计下降 ≥ 10 dB），线性拟合出衰减速度，T60 = 60 dB / 速度。取较慢一半的中位数，
// 因为快的下降多半是辅音本身收尾，慢的才反映房间混响。干声通常 < 0.3 秒。
export function estimateT60(channels, fs) {
  const x = channels[0];
  const n = Math.round(0.005 * fs);
  const rates = [];
  for (const [lo, hi] of [[500, 1000], [1000, 2000], [2000, 4000]]) {
    let y = filter(x, design('highpass', fs, lo));
    y = filter(filter(y, design('lowpass', fs, hi)), design('highpass', fs, lo));
    const lv = [];
    for (let s = 0; s + n <= y.length; s += n) {
      let e = 0;
      for (let i = s; i < s + n; i++) e += y[i] * y[i];
      lv.push(10 * Math.log10(e / n + 1e-20));
    }
    const sorted = [...lv].sort((p, q) => p - q);
    const loud = sorted[Math.floor(0.9 * (sorted.length - 1))];
    const floor = sorted[Math.floor(0.1 * (sorted.length - 1))];
    let i = 0;
    while (i < lv.length - 1) {
      if (lv[i] < loud - 20) { i++; continue; }
      let j = i, peak = lv[i];
      while (j + 1 < lv.length && lv[j + 1] <= Math.min(peak, lv[j] + 1) && lv[j + 1] > floor + 5) { j++; peak = Math.min(peak, lv[j] + 1); }
      if (j - i >= 8 && lv[i] - lv[j] >= 10) {
        const m = j - i + 1, mx = (m - 1) / 2;
        let sxy = 0, sxx = 0, my = 0;
        for (let k = 0; k < m; k++) my += lv[i + k] / m;
        for (let k = 0; k < m; k++) { sxy += (k - mx) * (lv[i + k] - my); sxx += (k - mx) ** 2; }
        const slope = sxy / sxx / 0.005; // dB/s
        if (slope < -20) rates.push(-slope);
      }
      i = j + 1;
    }
  }
  if (rates.length < 5) return NaN;
  rates.sort((p, q) => p - q);
  const slow = rates.slice(0, Math.ceil(rates.length / 2));
  return 60 / slow[Math.floor(slow.length / 2)];
}

// t60：假定的混响时间（秒）；strength 0..1 控制最多压低多少。
export function dereverb(channels, fs, { t60 = 0.6, strength = 1, maxReductionDb = 18, delayMs = 40 } = {}) {
  if (strength <= 0 || !(t60 > 0)) return channels.map((x) => Float32Array.from(x));
  const n = frameSizeFor(fs);
  const hop = n / 4;
  const bins = n / 2 + 1;
  const D = Math.max(1, Math.round((delayMs / 1000) * fs / hop));
  const delta = (3 * Math.LN10) / t60;
  const decay = Math.exp((-2 * delta * D * hop) / fs);
  const floor = Math.pow(10, -(strength * maxReductionDb) / 20);
  const history = Array.from({ length: D + 1 }, () => new Float64Array(bins));
  const smooth = new Float64Array(bins);
  const raw = new Float64Array(bins);
  let pos = 0;
  return processFrames(channels, n, (_f, p, g) => {
    const past = history[(pos + 1) % (D + 1)]; // D 帧以前的平滑功率
    for (let k = 0; k < bins; k++) {
      smooth[k] = 0.5 * smooth[k] + 0.5 * p[k];
      const late = decay * past[k];
      raw[k] = Math.max(floor, 1 - (strength * late) / (p[k] + 1e-20));
    }
    history[pos].set(smooth);
    pos = (pos + 1) % (D + 1);
    for (let k = 0; k < bins; k++) g[k] = 0.25 * raw[Math.max(0, k - 1)] + 0.5 * raw[k] + 0.25 * raw[Math.min(bins - 1, k + 1)];
  });
}
