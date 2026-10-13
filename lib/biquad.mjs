// RBJ 双二阶滤波器设计与直接 II 型转置实现。
export function design(type, fs, f0, { q = Math.SQRT1_2, gainDb = 0 } = {}) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cs = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const sa = 2 * Math.sqrt(A) * alpha;
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
    case 'highpass':
      b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A; break;
    case 'lowshelf':
      b0 = A * (A + 1 - (A - 1) * cs + sa); b1 = 2 * A * (A - 1 - (A + 1) * cs); b2 = A * (A + 1 - (A - 1) * cs - sa);
      a0 = A + 1 + (A - 1) * cs + sa; a1 = -2 * (A - 1 + (A + 1) * cs); a2 = A + 1 + (A - 1) * cs - sa; break;
    case 'highshelf':
      b0 = A * (A + 1 + (A - 1) * cs + sa); b1 = -2 * A * (A - 1 + (A + 1) * cs); b2 = A * (A + 1 + (A - 1) * cs - sa);
      a0 = A + 1 - (A - 1) * cs + sa; a1 = 2 * (A - 1 - (A + 1) * cs); a2 = A + 1 - (A - 1) * cs - sa; break;
    default: throw new Error(`未知滤波器类型：${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function filter(x, { b0, b1, b2, a1, a2 }) {
  const y = new Float32Array(x.length);
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const o = b0 * v + z1;
    z1 = b1 * v - a1 * o + z2;
    z2 = b2 * v - a2 * o;
    y[i] = o;
  }
  return y;
}
