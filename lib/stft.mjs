// 短时傅里叶变换：Hann 窗、75% 重叠、加权重叠相加重建。
import { makeFFT } from './fft.mjs';

// 约 20 ms 的帧长，取 2 的幂。
export function frameSizeFor(sampleRate) {
  let n = 256;
  while (n < sampleRate * 0.02) n *= 2;
  return n;
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// 逐帧计算各声道平均功率谱，cb(frameIndex, power) 拿到长度 n/2+1 的功率。
export function forEachSpectrum(channels, n, cb) {
  runFrames(channels, n, cb, false);
}

// 逐帧调用 gainCb(frameIndex, power, gains) 填写每个频点的增益，所有声道共用同一组增益。
export function processFrames(channels, n, gainCb) {
  return runFrames(channels, n, gainCb, true);
}

function runFrames(channels, n, cb, synthesize) {
  const hop = n / 4;
  const len = channels[0].length;
  const bins = n / 2 + 1;
  const fft = makeFFT(n);
  const win = hann(n);
  const norm = 1.5; // Hann² 在 75% 重叠下的叠加和
  const re = channels.map(() => new Float64Array(n));
  const im = channels.map(() => new Float64Array(n));
  const power = new Float64Array(bins);
  const gains = new Float64Array(bins);
  const out = synthesize ? channels.map(() => new Float32Array(len)) : null;
  let frame = 0;
  for (let t = -n + hop; t < len; t += hop, frame++) {
    power.fill(0);
    for (let c = 0; c < channels.length; c++) {
      const x = channels[c], r = re[c], m = im[c];
      for (let i = 0; i < n; i++) {
        const s = t + i;
        r[i] = s >= 0 && s < len ? x[s] * win[i] : 0;
        m[i] = 0;
      }
      fft.transform(r, m);
      for (let k = 0; k < bins; k++) power[k] += (r[k] * r[k] + m[k] * m[k]) / channels.length;
    }
    if (!synthesize) { cb(frame, power); continue; }
    gains.fill(1);
    cb(frame, power, gains);
    for (let c = 0; c < channels.length; c++) {
      const r = re[c], m = im[c], o = out[c];
      for (let k = 0; k < bins; k++) { r[k] *= gains[k]; m[k] *= gains[k]; }
      for (let k = 1; k < n / 2; k++) { r[n - k] *= gains[k]; m[n - k] *= gains[k]; }
      fft.transform(r, m, true);
      for (let i = 0; i < n; i++) {
        const s = t + i;
        if (s >= 0 && s < len) o[s] += (r[i] * win[i]) / norm;
      }
    }
  }
  return out;
}
