// 合成“像语音”的测试信号：带音高起伏的谐波源 + 共振峰 + 音节包络 + 擦音，以及几种噪声。
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOWELS = [ // F1, F2, F3（Hz）
  [730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410],
];

// 返回 { signal, active }：active 标记有声的采样（用于测量停顿处的残余噪声）。
export function speechLike(fs, seconds, { seed = 1, f0 = 130, formantScale = 1 } = {}) {
  const r = rng(seed);
  const len = Math.round(fs * seconds);
  const env = new Float32Array(len);
  const fric = new Float32Array(len);
  const formants = new Float32Array(len * 3);
  let t = Math.round(0.3 * fs);
  let prev = VOWELS[0].map((f) => f * formantScale);
  while (t < len - 0.3 * fs) {
    const dur = Math.round((0.12 + 0.18 * r()) * fs);
    const v = VOWELS[Math.floor(r() * VOWELS.length)].map((f) => f * formantScale);
    const att = Math.round(0.02 * fs), rel = Math.round(0.04 * fs);
    if (r() < 0.4) { // 音节开头的擦音
      const fl = Math.round(0.06 * fs);
      for (let i = 0; i < fl && t - fl + i >= 0; i++) fric[t - fl + i] = Math.sin((Math.PI * i) / fl) * 0.25;
    }
    for (let i = 0; i < dur && t + i < len; i++) {
      const a = i < att ? i / att : i > dur - rel ? (dur - i) / rel : 1;
      env[t + i] = a * (0.7 + 0.3 * Math.sin((Math.PI * i) / dur));
      const m = Math.min(1, i / (0.05 * fs));
      for (let k = 0; k < 3; k++) formants[(t + i) * 3 + k] = prev[k] * (1 - m) + v[k] * m;
    }
    prev = v;
    t += dur + Math.round((r() < 0.3 ? 0.15 + 0.35 * r() : 0.02 + 0.04 * r()) * fs);
  }
  const bw = [80, 100, 120];
  const maxH = 60;
  const amps = new Float64Array(maxH + 1);
  const signal = new Float32Array(len);
  let phase = 0, f = f0;
  let noisePrev = 0;
  for (let i = 0; i < len; i++) {
    const time = i / fs;
    f = f0 * (1 + 0.12 * Math.sin(2 * Math.PI * 0.6 * time + seed) - 0.05 * ((time % 3) / 3));
    phase += (2 * Math.PI * f) / fs;
    if (phase > 2 * Math.PI * 1000) phase -= 2 * Math.PI * 1000;
    if (i % 64 === 0) { // 每 64 个采样更新一次各次谐波的共振峰增益
      const F = formants[i * 3] ? formants.subarray(i * 3, i * 3 + 3) : prev;
      for (let h = 1; h <= maxH; h++) {
        const hf = h * f;
        if (hf > 0.45 * fs || hf > 7500) { amps[h] = 0; continue; }
        let g = 1 / h;
        for (let k = 0; k < 3; k++) {
          const x = hf / F[k];
          g /= Math.sqrt((1 - x * x) ** 2 + ((hf * bw[k]) / (F[k] * F[k])) ** 2);
        }
        amps[h] = g;
      }
    }
    let v = 0;
    if (env[i] > 0) for (let h = 1; h <= maxH && amps[h]; h++) v += amps[h] * Math.sin(h * phase);
    const wn = r() * 2 - 1;
    const hiss = wn - noisePrev; // 一阶差分 = 高频偏重的嘶声
    noisePrev = wn;
    signal[i] = 0.05 * v * env[i] + fric[i] * hiss * 0.5;
  }
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(signal[i]));
  const active = new Uint8Array(len);
  for (let i = 0; i < len; i++) { signal[i] *= 0.5 / peak; active[i] = env[i] > 0 || fric[i] > 0 ? 1 : 0; }
  return { signal, active };
}

export function whiteNoise(len, seed) {
  const r = rng(seed);
  return Float32Array.from({ length: len }, () => r() * 2 - 1);
}

export function pinkNoise(len, seed) { // Paul Kellet 粉红噪声滤波
  const r = rng(seed);
  const y = new Float32Array(len);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    y[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return y;
}

export function hum(len, fs, base = 50) { // 电源嗡声：基频与若干奇次谐波
  return Float32Array.from({ length: len }, (_, i) => {
    let v = 0;
    for (const [h, a] of [[1, 1], [3, 0.5], [5, 0.3], [7, 0.15]]) v += a * Math.sin((2 * Math.PI * base * h * i) / fs);
    return v;
  });
}

export function rms(x, mask = null, want = 1) {
  let s = 0, n = 0;
  for (let i = 0; i < x.length; i++) if (!mask || mask[i] === want) { s += x[i] * x[i]; n++; }
  return Math.sqrt(s / Math.max(n, 1));
}
