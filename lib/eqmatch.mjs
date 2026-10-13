// 音色匹配：比较长时平均频谱（1/6 倍频程），算出平滑的 EQ 曲线并以零相位方式施加。
import { frameSizeFor, forEachSpectrum, processFrames } from './stft.mjs';

// 固定的 1/6 倍频程中心频率，约 40 Hz – 16 kHz，所有文件共用便于比较。
// 比常见的 1/3 倍频程更细，能分辨鼻音、齿音这类窄频段的差别。
const PER_OCTAVE = 6;
export const CENTERS = Array.from({ length: 53 }, (_, i) => 1000 * Math.pow(2, (i - 28) / PER_OCTAVE));

const SHAPE_LO = 150, SHAPE_HI = 6000;

// 返回 { shape, snrDb }：shape 是每个 1/6 倍频程频带相对电平（dB，已减去 150 Hz–6 kHz 的平均值），
// snrDb 是该频带有声段相对最安静 15% 帧的电平差；高于 0.45·fs 的频带为 NaN。
export function bandProfile(channels, fs) {
  const n = frameSizeFor(fs);
  const energies = [];
  forEachSpectrum(channels, n, (_f, p) => energies.push(p.reduce((a, v) => a + v, 0)));
  const sorted = [...energies].sort((a, b) => a - b);
  const pct = (q) => sorted[Math.floor(q * (sorted.length - 1))] || 0;
  // 有声帧：比响亮帧（第 90 百分位）低不超过 35 dB，且明显高于底噪。阈值放得低，
  // 是为了把齿音、擦音这类能量小的高频帧也算进来，否则提升高频后它们才“入选”，测量会失真。
  const quiet = pct(0.15);
  const loud = Math.max(pct(0.9) * Math.pow(10, -3.5), quiet * 4, 1e-30);
  const active = new Float64Array(n / 2 + 1);
  const noise = new Float64Array(n / 2 + 1);
  let na = 0, nq = 0;
  forEachSpectrum(channels, n, (f, p) => {
    if (energies[f] >= loud) { na++; for (let k = 0; k < p.length; k++) active[k] += p[k]; }
    else if (energies[f] <= quiet) { nq++; for (let k = 0; k < p.length; k++) noise[k] += p[k]; }
  });
  const binHz = fs / n;
  const band = (acc, count, fc) => {
    const lo = fc * Math.pow(2, -0.5 / PER_OCTAVE), hi = fc * Math.pow(2, 0.5 / PER_OCTAVE);
    let sum = 0, cnt = 0;
    for (let k = Math.ceil(lo / binHz); k * binHz < hi && k < acc.length; k++) { sum += acc[k]; cnt++; }
    if (!cnt) { sum = acc[Math.min(acc.length - 1, Math.round(fc / binHz))]; cnt = 1; }
    return 10 * Math.log10(sum / cnt / Math.max(count, 1) + 1e-30);
  };
  const db = CENTERS.map((fc) => (fc > 0.45 * fs ? NaN : band(active, na, fc)));
  const snrDb = CENTERS.map((fc, i) => (fc > 0.45 * fs ? NaN : db[i] - band(noise, nq, fc)));
  const ref = CENTERS.map((fc, i) => (fc >= SHAPE_LO && fc <= SHAPE_HI ? db[i] : NaN)).filter(Number.isFinite);
  const mean = ref.reduce((a, v) => a + v, 0) / ref.length;
  return { shape: db.map((v) => v - mean), snrDb };
}

export function spectralShape(channels, fs) {
  return bandProfile(channels, fs).shape;
}

export function averageShape(shapes) {
  return CENTERS.map((_, i) => {
    const vals = shapes.map((s) => s[i]).filter(Number.isFinite);
    return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : NaN;
  });
}

// 两条频谱形状的差异：100 Hz–8 kHz 内逐频带差值（去掉平均）的均方根（dB）。
// 传入 snrDb 时只比较原录音里确有语音的频带（SNR ≥ 10 dB），录音时就丢掉的频带无法找回，不计入。
export function shapeDistance(a, b, snrDb = null) {
  const d = [];
  CENTERS.forEach((fc, i) => {
    if (fc < 100 || fc > 8000 || !Number.isFinite(a[i]) || !Number.isFinite(b[i])) return;
    if (snrDb && !(snrDb[i] >= 10)) return;
    d.push(a[i] - b[i]);
  });
  const m = d.reduce((s, v) => s + v, 0) / d.length;
  return Math.sqrt(d.reduce((s, v) => s + (v - m) ** 2, 0) / d.length);
}

// 计算每个频带的 EQ 增益（dB）。只在源录音该频带确实有语音（band SNR 足够）时才提升，
// 否则提升的只会是噪声，比如电话录音 3.4 kHz 以上已经没有语音内容。
export function eqCurve(src, tgt, { strength = 1, maxDb = 12, snrDb = null } = {}) {
  const raw = CENTERS.map((_, i) => {
    if (!Number.isFinite(src[i]) || !Number.isFinite(tgt[i])) return 0;
    const d = tgt[i] - src[i];
    if (d <= 0 || !snrDb) return d;
    return d * Math.max(0, Math.min(1, (snrDb[i] - 6) / 12));
  });
  const smooth = raw.map((v, i) => 0.25 * (raw[i - 1] ?? v) + 0.5 * v + 0.25 * (raw[i + 1] ?? v));
  const defined = smooth.filter((_, i) => CENTERS[i] >= SHAPE_LO && CENTERS[i] <= SHAPE_HI);
  const offset = defined.reduce((a, v) => a + v, 0) / defined.length; // 总电平交给响度步骤
  return smooth.map((v) => Math.max(-maxDb, Math.min(maxDb, strength * (v - offset))));
}

export function applyEq(channels, fs, gainsDb) {
  const n = frameSizeFor(fs);
  const bins = n / 2 + 1;
  const logC = CENTERS.map(Math.log2);
  const curve = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const lf = Math.log2(Math.max((k * fs) / n, 1));
    let db;
    if (lf <= logC[0]) db = gainsDb[0];
    else if (lf >= logC[logC.length - 1]) db = gainsDb[gainsDb.length - 1];
    else {
      const j = logC.findIndex((v) => v > lf) - 1;
      const t = (lf - logC[j]) / (logC[j + 1] - logC[j]);
      db = gainsDb[j] * (1 - t) + gainsDb[j + 1] * t;
    }
    curve[k] = Math.pow(10, db / 20);
  }
  return processFrames(channels, n, (_f, _p, g) => g.set(curve));
}
