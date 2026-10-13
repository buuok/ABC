// WAV 读写：PCM 8/16/24/32 位、32/64 位浮点、WAVE_FORMAT_EXTENSIBLE。
export function decodeWav(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件（缺少 RIFF/WAVE 头）');
  }
  let fmt = null, data = null;
  for (let p = 12; p + 8 <= b.length;) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      let format = b.readUInt16LE(body);
      if (format === 0xfffe && size >= 26) format = b.readUInt16LE(body + 24);
      fmt = { format, channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = b.subarray(body, Math.min(b.length, body + size));
    }
    p = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV 文件缺少 fmt 或 data 块');
  const { format, channels: nc, sampleRate, bits } = fmt;
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * nc));
  const channels = Array.from({ length: nc }, () => new Float32Array(frames));
  let read;
  if (format === 1 && bits === 8) read = (o) => (data[o] - 128) / 128;
  else if (format === 1 && bits === 16) read = (o) => data.readInt16LE(o) / 32768;
  else if (format === 1 && bits === 24) read = (o) => data.readIntLE(o, 3) / 8388608;
  else if (format === 1 && bits === 32) read = (o) => data.readInt32LE(o) / 2147483648;
  else if (format === 3 && bits === 32) read = (o) => data.readFloatLE(o);
  else if (format === 3 && bits === 64) read = (o) => data.readDoubleLE(o);
  else throw new Error(`不支持的 WAV 格式：format=${format} bits=${bits}`);
  for (let i = 0, o = 0; i < frames; i++) for (let c = 0; c < nc; c++, o += bytes) channels[c][i] = read(o);
  return { sampleRate, channels };
}

// bits: 16 / 24（整数 PCM，TPDF 抖动）或 32（浮点）。
export function encodeWav({ sampleRate, channels }, bits = 24) {
  const nc = channels.length;
  const frames = channels[0].length;
  const isFloat = bits === 32;
  const bytes = bits / 8;
  const dataSize = frames * nc * bytes;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + dataSize, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(isFloat ? 3 : 1, 20);
  b.writeUInt16LE(nc, 22); b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * nc * bytes, 28);
  b.writeUInt16LE(nc * bytes, 32); b.writeUInt16LE(bits, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(dataSize, 40);
  const scale = bits === 16 ? 32767 : 8388607;
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nc; c++, o += bytes) {
      const v = channels[c][i];
      if (isFloat) { b.writeFloatLE(v, o); continue; }
      const q = Math.round(v * scale + Math.random() - Math.random());
      const s = Math.max(-scale - 1, Math.min(scale, q));
      if (bits === 16) b.writeInt16LE(s, o); else b.writeIntLE(s, o, 3);
    }
  }
  return b;
}
