// 经典降噪：从最安静的帧估计噪声谱，再用判决引导（decision-directed）的维纳滤波逐帧抑制。
import { frameSizeFor, forEachSpectrum, processFrames } from './stft.mjs';

export function estimateNoise(channels, fs, quietFraction = 0.15) {
  const n = frameSizeFor(fs);
  const energies = [];
  forEachSpectrum(channels, n, (_f, p) => {
    let e = 0;
    for (let k = 0; k < p.length; k++) e += p[k];
    energies.push(e);
  });
  const sorted = [...energies].sort((a, b) => a - b);
  const threshold = sorted[Math.max(0, Math.floor(quietFraction * (sorted.length - 1)))];
  const noise = new Float64Array(n / 2 + 1);
  let count = 0;
  forEachSpectrum(channels, n, (f, p) => {
    if (energies[f] > threshold) return;
    for (let k = 0; k < p.length; k++) noise[k] += p[k];
    count++;
  });
  for (let k = 0; k < noise.length; k++) noise[k] = noise[k] / Math.max(count, 1) + 1e-20;
  return { n, noise };
}

// strength 0..1：0 不处理，1 最多压低 maxReductionDb。
export function denoise(channels, fs, { strength = 0.7, maxReductionDb = 24 } = {}) {
  if (strength <= 0) return channels.map((x) => Float32Array.from(x));
  const { n, noise } = estimateNoise(channels, fs);
  const floor = Math.pow(10, -(strength * maxReductionDb) / 20);
  const over = 1 + 0.5 * strength; // 适度过减，压住残余噪声
  const alpha = 0.98;
  const bins = n / 2 + 1;
  const prevClean = new Float64Array(bins);
  const raw = new Float64Array(bins);
  return processFrames(channels, n, (_f, p, g) => {
    for (let k = 0; k < bins; k++) {
      const N = noise[k] * over;
      const gamma = p[k] / N;
      const xi = Math.max(alpha * (prevClean[k] / N) + (1 - alpha) * Math.max(gamma - 1, 0), 1e-3);
      const G = xi / (1 + xi);
      prevClean[k] = G * G * p[k];
      raw[k] = Math.max(G, floor);
    }
    // 沿频率轻微平滑，减少“音乐噪声”。
    for (let k = 0; k < bins; k++) {
      const a = raw[Math.max(0, k - 1)], c = raw[Math.min(bins - 1, k + 1)];
      g[k] = 0.25 * a + 0.5 * raw[k] + 0.25 * c;
    }
  });
}
