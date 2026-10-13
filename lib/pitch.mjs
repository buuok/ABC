// 音高与共振峰：YIN 估计基频；倒谱求频谱包络；相位声码器移调，同时按需要平移共振峰。
// 用途：同一个人（或同一个 AI 音色）的不同片段，音高或共振峰略有偏差时把它们对齐。
import { makeFFT } from './fft.mjs';
import { design, filter } from './biquad.mjs';
import { forEachSpectrum } from './stft.mjs';

const mixdown = (channels) => {
  if (channels.length === 1) return channels[0];
  const m = new Float32Array(channels[0].length);
  for (const x of channels) for (let i = 0; i < m.length; i++) m[i] += x[i] / channels.length;
  return m;
};

// 基频估计（YIN）：先降采样到约 12 kHz，30 ms 窗、10 ms 步长。返回有声帧基频的典型值 hz 和有声帧数。
// 典型值取去掉最高、最低各 10% 后的对数平均：真实语音的基频常是双峰分布（语调起伏），中位数会落在两峰之间来回跳。
export function estimateF0(channels, fs, { fmin = 60, fmax = 450 } = {}) {
  const D = Math.max(1, Math.floor(fs / 12000));
  let x = mixdown(channels);
  if (D > 1) {
    const lp = design('lowpass', fs, (0.4 * fs) / D);
    x = filter(filter(x, lp), lp);
    x = Float32Array.from({ length: Math.floor(x.length / D) }, (_, i) => x[i * D]);
  }
  const fsd = fs / D;
  const W = Math.round(0.03 * fsd), step = Math.round(0.01 * fsd);
  const tauMin = Math.floor(fsd / fmax), tauMax = Math.ceil(fsd / fmin);
  const rmsList = [];
  for (let s = 0; s + W + tauMax < x.length; s += step) {
    let e = 0;
    for (let j = 0; j < W; j++) e += x[s + j] * x[s + j];
    rmsList.push(Math.sqrt(e / W));
  }
  const gate = Math.max(...rmsList, 0) * 0.03;
  const d = new Float64Array(tauMax + 1);
  const f0s = [];
  rmsList.forEach((rms, fi) => {
    if (rms < gate) return;
    const s = fi * step;
    let run = 0;
    let best = -1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let acc = 0;
      for (let j = 0; j < W; j++) { const v = x[s + j] - x[s + j + tau]; acc += v * v; }
      run += acc;
      d[tau] = run > 0 ? (acc * tau) / run : 1;
    }
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (d[tau] < 0.15) {
        while (tau + 1 < tauMax && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) return;
    const a = d[best - 1], b = d[best], c = d[best + 1];
    const den = a - 2 * b + c;
    const t = den > 0 ? best + (0.5 * (a - c)) / den : best;
    f0s.push(fsd / t);
  });
  if (f0s.length < 5) return { hz: NaN, voicedFrames: f0s.length };
  f0s.sort((p, q) => p - q);
  const mid = f0s.slice(Math.floor(f0s.length * 0.1), Math.ceil(f0s.length * 0.9));
  return { hz: Math.exp(mid.reduce((a, v) => a + Math.log(v), 0) / mid.length), voicedFrames: f0s.length };
}

export const semitones = (f, ref) => 12 * Math.log2(f / ref);

const pvSize = (fs) => { let n = 512; while (n < fs * 0.04) n *= 2; return n; };

// 倒谱平滑：输入自然对数幅度谱（n/2+1 点），返回平滑后的对数包络。
function cepstralEnvelope(logMag, n, lifter, fft, re, im) {
  const bins = n / 2 + 1;
  for (let k = 0; k < bins; k++) { re[k] = logMag[k]; im[k] = 0; }
  for (let k = 1; k < n / 2; k++) { re[n - k] = logMag[k]; im[n - k] = 0; }
  fft.transform(re, im, true);
  for (let q = lifter; q <= n - lifter; q++) { re[q] = 0; im[q] = 0; }
  for (let q = 0; q < n; q++) im[q] = 0;
  fft.transform(re, im);
  return re.subarray(0, bins);
}

const lifterFor = (fs) => Math.max(8, Math.round(fs / 600)); // 约 1.7 ms，低于最高基频的周期

// 对数频率网格（1/24 倍频程，150 Hz–6 kHz）上的平均频谱包络（dB），只统计有声帧。
export const ENV_GRID = Array.from({ length: Math.floor(24 * Math.log2(6000 / 150)) + 1 }, (_, i) => 150 * Math.pow(2, i / 24));

export function envelopeProfile(channels, fs) {
  const n = pvSize(fs);
  const bins = n / 2 + 1;
  const fft = makeFFT(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  const energies = [];
  forEachSpectrum(channels, n, (_f, p) => energies.push(p.reduce((a, v) => a + v, 0)));
  const sorted = [...energies].sort((a, b) => a - b);
  const threshold = Math.max(sorted[Math.floor(0.5 * (sorted.length - 1))] || 0, (sorted[sorted.length - 1] || 0) * 1e-4);
  const acc = new Float64Array(bins);
  const logMag = new Float64Array(bins);
  let count = 0;
  forEachSpectrum(channels, n, (f, p) => {
    if (energies[f] < threshold) return;
    for (let k = 0; k < bins; k++) logMag[k] = 0.5 * Math.log(p[k] + 1e-12);
    const env = cepstralEnvelope(logMag, n, lifterFor(fs), fft, re, im);
    for (let k = 0; k < bins; k++) acc[k] += env[k];
    count++;
  });
  const binHz = fs / n;
  return ENV_GRID.map((f) => {
    const k = f / binHz, k0 = Math.floor(k), t = k - k0;
    if (k0 + 1 >= bins || !count) return NaN;
    return ((acc[k0] * (1 - t) + acc[k0 + 1] * t) / count) * (20 / Math.LN10);
  });
}

// 估计共振峰缩放：找 α 使 clip 包络整体乘 α 后与 target 最吻合（先去掉均值和线性倾斜，倾斜交给 EQ）。
export function estimateFormantWarp(clip, target, { maxRatio = 1.1 } = {}) {
  const steps = 24; // 网格每倍频程的点数
  const detrend = (arr) => {
    const idx = arr.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
    const mx = idx.reduce((a, i) => a + i, 0) / idx.length;
    const my = idx.reduce((a, i) => a + arr[i], 0) / idx.length;
    const sxy = idx.reduce((a, i) => a + (i - mx) * (arr[i] - my), 0);
    const sxx = idx.reduce((a, i) => a + (i - mx) ** 2, 0);
    const slope = sxx ? sxy / sxx : 0;
    return arr.map((v, i) => v - my - slope * (i - mx));
  };
  const at = (arr, pos) => {
    const i = Math.floor(pos), t = pos - i;
    if (i < 0 || i + 1 >= arr.length) return NaN;
    return arr[i] * (1 - t) + arr[i + 1] * t;
  };
  let best = { alpha: 1, err: Infinity };
  for (let lg = -Math.log2(maxRatio); lg <= Math.log2(maxRatio) + 1e-9; lg += 1 / 240) {
    const shift = lg * steps; // clip 在频率 f/α 处的值 → 网格下标 i - shift
    const warped = detrend(target.map((_, i) => at(clip, i - shift)));
    const tgt = detrend(target.map((v, i) => (Number.isFinite(warped[i]) ? v : NaN)));
    let err = 0, cnt = 0;
    for (let i = 0; i < tgt.length; i++) if (Number.isFinite(warped[i]) && Number.isFinite(tgt[i])) { err += (warped[i] - tgt[i]) ** 2; cnt++; }
    if (cnt < target.length * 0.7) continue;
    err /= cnt;
    if (err < best.err - 1e-9 || (Math.abs(err - best.err) < 1e-9 && Math.abs(lg) < Math.abs(Math.log2(best.alpha)))) best = { alpha: Math.pow(2, lg), err };
  }
  return best.alpha;
}

// 移调（ratio>1 升高）并把共振峰乘以 formantRatio；formantRatio=1 时保持原共振峰不变。
// 用 Laroche-Dolson 的“峰值区域整体搬移 + 相位锁定”：每个谐波峰连同两侧的频点一起平移，
// 峰内的相位关系保持不变，避免普通相位声码器那种发虚、像加了混响的“相位感”。
export function shiftPitchFormant(channels, fs, ratio, formantRatio = 1) {
  if (Math.abs(Math.log2(ratio)) < 1e-4 && Math.abs(Math.log2(formantRatio)) < 1e-4) return channels.map((x) => Float32Array.from(x));
  const n = pvSize(fs);
  const osamp = 4;
  const hop = n / osamp;
  const bins = n / 2 + 1;
  const fft = makeFFT(n);
  const win = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const norm = 0.375 * osamp; // Hann² 在该重叠下的叠加和
  const expct = (2 * Math.PI * hop) / n;
  const lifter = lifterFor(fs);
  const len = channels[0].length;
  return channels.map((x) => {
    const out = new Float32Array(len);
    const re = new Float64Array(n), im = new Float64Array(n);
    const cre = new Float64Array(n), cim = new Float64Array(n);
    const lastPhase = new Float64Array(bins);
    const rot = new Float64Array(bins), rotPrev = new Float64Array(bins);
    const mag = new Float64Array(bins), phase = new Float64Array(bins), freq = new Float64Array(bins);
    const oRe = new Float64Array(bins), oIm = new Float64Array(bins);
    const logMag = new Float64Array(bins);
    const peaks = [];
    for (let t = -n + hop; t < len; t += hop) {
      for (let i = 0; i < n; i++) { const s = t + i; re[i] = s >= 0 && s < len ? x[s] * win[i] : 0; im[i] = 0; }
      fft.transform(re, im);
      for (let k = 0; k < bins; k++) {
        mag[k] = Math.hypot(re[k], im[k]);
        phase[k] = Math.atan2(im[k], re[k]);
        let d = phase[k] - lastPhase[k] - k * expct;
        lastPhase[k] = phase[k];
        d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
        freq[k] = k + (d * osamp) / (2 * Math.PI); // 真实频率（以频点为单位）
        logMag[k] = Math.log(mag[k] + 1e-9);
      }
      const env = Float64Array.from(cepstralEnvelope(logMag, n, lifter, fft, cre, cim));
      // 找峰：比左右各两个频点都大。
      peaks.length = 0;
      for (let k = 2; k < bins - 2; k++) {
        if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > mag[k - 2] && mag[k] >= mag[k + 2]) peaks.push(k);
      }
      oRe.fill(0); oIm.fill(0); rot.fill(0);
      for (let p = 0; p < peaks.length; p++) {
        const kp = peaks[p];
        const lo = p === 0 ? 0 : Math.ceil((peaks[p - 1] + kp) / 2);
        const hi = p === peaks.length - 1 ? bins - 1 : Math.floor((kp + peaks[p + 1]) / 2);
        const target = kp * ratio;
        const shift = Math.round(target) - kp;
        const ko = kp + shift;
        if (ko <= 0 || ko >= bins) continue;
        // 搬到新位置后，峰每帧要多转 (ω'−ω)·hop；在上一帧同一输出频点的旋转量上累加，保证帧间连续。
        const ang = rotPrev[ko] + (freq[kp] * (ratio - 1) * 2 * Math.PI) / osamp;
        for (let k = lo; k <= hi; k++) {
          const kk = k + shift;
          if (kk < 0 || kk >= bins) continue;
          const srcEnv = env[k];
          const pos = kk / formantRatio, k0 = Math.floor(pos), tt = pos - k0;
          const dstEnv = k0 + 1 < bins ? env[k0] * (1 - tt) + env[k0 + 1] * tt : env[bins - 1];
          const m = mag[k] * Math.exp(dstEnv - srcEnv);
          const ph = phase[k] + ang;
          oRe[kk] += m * Math.cos(ph);
          oIm[kk] += m * Math.sin(ph);
          rot[kk] = ang;
        }
      }
      rotPrev.set(rot);
      for (let k = 0; k < bins; k++) { re[k] = oRe[k]; im[k] = oIm[k]; }
      im[0] = 0; im[bins - 1] = 0;
      for (let k = 1; k < n / 2; k++) { re[n - k] = re[k]; im[n - k] = -im[k]; }
      fft.transform(re, im, true);
      for (let i = 0; i < n; i++) { const s = t + i; if (s >= 0 && s < len) out[s] += (re[i] * win[i]) / norm; }
    }
    return out;
  });
}
