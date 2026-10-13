// 基 2 复数 FFT，原地变换。
const cache = new Map();

export function makeFFT(n) {
  if (cache.has(n)) return cache.get(n);
  const levels = Math.log2(n);
  if (!Number.isInteger(levels)) throw new Error(`FFT 长度必须是 2 的幂：${n}`);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let j = 0, x = i; j < levels; j++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  function transform(re, im, inverse = false) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k];
          const wi = inverse ? sin[k] : -sin[k];
          const a = i + j;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
  const fft = { n, transform };
  cache.set(n, fft);
  return fft;
}
