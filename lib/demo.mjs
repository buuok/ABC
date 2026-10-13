// 演示数据：同一个“说话人”的四段录音，录音设备、距离和环境噪声各不相同。
import { speechLike, whiteNoise, pinkNoise, hum, rms } from './synth.mjs';
import { design, filter } from './biquad.mjs';

const SCENES = [
  { name: '01-参考-安静房间', gainDb: -3, chain: [], noise: 'white', snrDb: 45 },
  { name: '02-手机-离得远', gainDb: -20, chain: [['highpass', 300, {}], ['lowpass', 3400, {}], ['peaking', 1500, { gainDb: 4, q: 1 }]], noise: 'pink', snrDb: 15 },
  { name: '03-领夹麦-电流声', gainDb: -8, chain: [['lowshelf', 200, { gainDb: 8 }], ['highshelf', 4000, { gainDb: -6 }]], noise: 'hum', snrDb: 12 },
  { name: '04-笔记本-风扇声', gainDb: -12, chain: [['highpass', 180, {}], ['highshelf', 3000, { gainDb: 7 }]], noise: 'pink+white', snrDb: 9 },
];

// 把有声标记向两侧扩 80 ms，剩下的才算“停顿”，避免把语音尾音算成噪声。
function pauseMask(active, fs) {
  const pad = Math.round(0.08 * fs);
  const mask = new Uint8Array(active.length).fill(1);
  for (let i = 0; i < active.length; i++) {
    if (!active[i]) continue;
    for (let j = Math.max(0, i - pad); j <= Math.min(active.length - 1, i + pad); j++) mask[j] = 0;
  }
  return mask;
}

export function makeDemoSet(fs = 48000, seconds = 8) {
  return SCENES.map((s, idx) => {
    const { signal, active } = speechLike(fs, seconds, { seed: 101 + idx, f0: 125 });
    let x = signal;
    for (const [type, f0, opts] of s.chain) x = filter(x, design(type, fs, f0, opts));
    const g = Math.pow(10, s.gainDb / 20);
    x = x.map((v) => v * g);
    const len = x.length;
    let n;
    if (s.noise === 'white') n = whiteNoise(len, idx);
    else if (s.noise === 'pink') n = pinkNoise(len, idx);
    else if (s.noise === 'hum') { const h = hum(len, fs), w = whiteNoise(len, idx); n = h.map((v, i) => v + 0.3 * w[i]); }
    else { const p = pinkNoise(len, idx), w = whiteNoise(len, idx + 50); n = p.map((v, i) => v + 0.2 * w[i]); }
    const speechRms = rms(x, active, 1);
    const k = speechRms / Math.pow(10, s.snrDb / 20) / rms(n);
    const mixed = x.map((v, i) => v + k * n[i]);
    return { name: s.name, sampleRate: fs, channels: [mixed], clean: signal, pauses: pauseMask(active, fs) };
  });
}

// 已知干净信号时的真实指标：有声段与停顿段电平之比（dB），越大说明残余噪声越少。
export function speechToPauseDb(channel, pauses) {
  return 20 * Math.log10(rms(channel, pauses, 0) / rms(channel, pauses, 1));
}

// AI 配音演示：同一个“AI 音色”的四段生成结果，音高、共振峰、明亮度各有偏差（噪声很小）。
const AI_TAKES = [
  { name: '01-主音色', st: 0, formant: 1, chain: [] },
  { name: '02-偏高偏亮', st: 2, formant: 1.06, chain: [['highshelf', 5000, { gainDb: 5 }]] },
  { name: '03-偏低偏闷', st: -1.5, formant: 0.95, chain: [['lowshelf', 200, { gainDb: 3 }], ['highshelf', 4000, { gainDb: -5 }]] },
  { name: '04-鼻音重', st: 0.8, formant: 1, chain: [['peaking', 1000, { gainDb: 6, q: 3 }], ['peaking', 3000, { gainDb: -5, q: 2 }]] },
];

export function makeAiVoiceSet(fs = 48000, seconds = 6) {
  return AI_TAKES.map((t, idx) => {
    const { signal } = speechLike(fs, seconds, { seed: 201 + idx, f0: 125 * Math.pow(2, t.st / 12), formantScale: t.formant });
    let x = signal;
    for (const [type, f0, opts] of t.chain) x = filter(x, design(type, fs, f0, opts));
    const g = Math.pow(10, (-6 - 3 * idx) / 20);
    const n = whiteNoise(x.length, 300 + idx);
    return { name: t.name, sampleRate: fs, channels: [x.map((v, i) => v * g + 3e-4 * n[i])] };
  });
}

// 把几段首尾相接拼成一个文件（模拟已经剪辑好的成片），段间留 0.8 秒停顿。
export function concatTakes(takes, name = '已拼好的成片') {
  const fs = takes[0].sampleRate;
  const gap = Math.round(0.8 * fs);
  const len = takes.reduce((a, t) => a + t.channels[0].length + gap, 0);
  const out = new Float32Array(len);
  let p = 0;
  for (const t of takes) { out.set(t.channels[0], p); p += t.channels[0].length + gap; }
  return { name, sampleRate: fs, channels: [out] };
}
