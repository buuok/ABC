// 批处理流程：降噪 → 音高 / 共振峰对齐 → 去混响（比基准“空”时）→ 音色匹配（EQ）→ 响度标准化 → 峰值限制。
// 分段模式下每个文件先在停顿处切开，每一段单独向目标对齐，再无缝拼回去。
import { denoise } from './denoise.mjs';
import { bandProfile, spectralShape, averageShape, shapeDistance, eqCurve, applyEq } from './eqmatch.mjs';
import { integratedLoudness, samplePeakDb, estimateSnrDb, applyGain } from './loudness.mjs';
import { estimateF0, envelopeProfile, estimateFormantWarp, shiftPitchFormant, semitones } from './pitch.mjs';
import { splitAtPauses } from './segment.mjs';
import { dereverb, decayTimeMs, estimateT60 } from './dereverb.mjs';
import { limit } from './limiter.mjs';
import { applyManual } from './manual.mjs';

// 音高、共振峰对齐默认关闭：真实片段试听中，不升调的版本最自然（用户 2026-10-10 选定）。
export const DEFAULTS = {
  targetLufs: -16, denoise: 0.7, dereverb: 1, eq: 1, eqMaxDb: 12, pitch: 0, formant: 0, peakDb: -1, reference: null, segment: false,
};

const PITCH_MIN_ST = 0.3; // 小于这个半音差不移调，避免无谓的处理痕迹
const PITCH_MAX_ST = 6;
const FORMANT_MIN = 0.02; // 共振峰偏差小于 2% 视为一致（估计误差约在这个量级）
const OVERLAP_S = 0.02;
// 比基准“空”的判断：停顿前尾音衰减 20 dB 的时间长出 30% 以上，或盲估的混响时间长出 30 ms 以上。
// 两个指标在 10 秒左右的片段上都有误差，所以任一个明显超出就处理，处理力度固定、偏保守。
function roomier(u, target) {
  return (Number.isFinite(u.reverbMs) && Number.isFinite(target.reverbMs) && u.reverbMs > target.reverbMs * 1.3)
    || (Number.isFinite(u.t60est) && Number.isFinite(target.t60est) && u.t60est > target.t60est + 0.03);
}

export function analyze({ sampleRate, channels }) {
  return {
    seconds: channels[0].length / sampleRate,
    lufs: integratedLoudness(channels, sampleRate),
    peakDb: samplePeakDb(channels),
    snrDb: estimateSnrDb(channels, sampleRate),
  };
}

const slice = (channels, a, b) => channels.map((x) => x.subarray(a, b));
const medianOf = (v) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const averageOf = (arrays) => arrays[0].map((_, i) => {
  const vals = arrays.map((a) => a[i]).filter(Number.isFinite);
  return vals.length ? vals.reduce((p, v) => p + v, 0) / vals.length : NaN;
});

function normalizeLoudness(ch, fs, o) {
  let limitedDb = 0;
  for (let pass = 0; pass < 3; pass++) {
    const l = integratedLoudness(ch, fs);
    if (!Number.isFinite(l) || Math.abs(l - o.targetLufs) < 0.1) break;
    const r = limit(applyGain(ch, o.targetLufs - l), fs, o.peakDb);
    ch = r.channels;
    limitedDb = Math.min(limitedDb, r.reducedDb);
  }
  return { ch, limitedDb };
}

// 主音色（目标）的全部特征。可以存下来，以后的批次直接用它当基准，不必再带上那段参考录音。
export function voiceProfile(audio, { denoise: strength = DEFAULTS.denoise } = {}) {
  const { sampleRate: fs } = audio;
  const ch = denoise(audio.channels, fs, { strength });
  return {
    f0: estimateF0(ch, fs).hz, env: envelopeProfile(ch, fs), shape: spectralShape(ch, fs),
    reverbMs: decayTimeMs(ch, fs), t60est: estimateT60(ch, fs), fileShape: bandProfile(audio.channels, fs).shape,
    lufs: integratedLoudness(audio.channels, fs),
  };
}

// 一段录音和主音色有多像：综合音色差、共振峰偏差和音高差，给 0–100 分。用来从多条重新生成的片段里挑最像的。
// 权重按真实 AI 片段标定：1-14（用户觉得像）约 80 分，1-15（不像）约 40 分。
export function similarity(p, target) {
  const timbreDb = shapeDistance(p.shape, target.shape);
  const formantPct = (estimateFormantWarp(p.env, target.env, { maxRatio: 1.3 }) - 1) * 100;
  const pitchSt = semitones(p.f0, target.f0);
  const penalty = 6 * (Number.isFinite(timbreDb) ? timbreDb : 5) + 2.5 * Math.abs(formantPct) + 5 * (Number.isFinite(pitchSt) ? Math.abs(pitchSt) : 2);
  return { score: Math.round(Math.max(0, Math.min(100, 100 - penalty))), timbreDb, formantPct, pitchSt };
}

// 进度权重：降噪、分析、逐段统一、汇总各占整体的比例。
const W = { denoise: 0.3, analyze: 0.15, unify: 0.45, report: 0.1 };

// inputs: [{ name, sampleRate, channels: Float32Array[] }]；reference：作为基准的文件下标，null 表示取全部平均；
// target：已保存的主音色（voiceProfile 的结果），给了它就不再从这批文件里求基准。
// manual：按文件下标的手动调音色设置（见 manual.mjs），没有就不调。
export function processBatch(inputs, options = {}) {
  const it = processSteps(inputs, options);
  for (;;) { const s = it.next(); if (s.done) return s.value; }
}

// 和 processBatch 一样，但每一步之间让出事件循环，并回调进度 { fraction, stage, file }（file 是文件下标）。
export async function processBatchAsync(inputs, options = {}, onProgress = () => {}) {
  const it = processSteps(inputs, options);
  for (;;) {
    const s = it.next();
    if (s.done) { onProgress({ fraction: 1, stage: '完成', file: null }); return s.value; }
    onProgress(s.value);
    await new Promise((ok) => setImmediate(ok));
  }
}

function* processSteps(inputs, options) {
  const o = { ...DEFAULTS, ...options };
  const ref = o.target ? null : o.reference;
  if (ref !== null && (ref < 0 || ref >= inputs.length)) throw new Error(`参考文件下标越界：${ref}`);
  const n = inputs.length;
  const before = inputs.map(analyze);
  // targetLufs 为 'reference' 时，音量跟主音色一样（没有主音色时取各段的中位数）。
  if (o.targetLufs === 'reference') {
    o.targetLufs = o.target?.lufs ?? (ref !== null ? before[ref].lufs : medianOf(before.map((b) => b.lufs)));
    if (!Number.isFinite(o.targetLufs)) o.targetLufs = DEFAULTS.targetLufs;
  }
  const profiles = inputs.map((a) => bandProfile(a.channels, a.sampleRate));
  const cleaned = [];
  for (const [i, a] of inputs.entries()) {
    yield { fraction: (W.denoise * i) / n, stage: '降噪', file: i };
    cleaned.push(denoise(a.channels, a.sampleRate, { strength: o.denoise }));
  }

  // 切成处理单元：普通模式一个文件一个单元，分段模式按停顿切开。
  const units = [];
  cleaned.forEach((ch, file) => {
    const fs = inputs[file].sampleRate;
    const len = ch[0].length;
    const cuts = o.segment ? splitAtPauses(ch, fs) : [0, len];
    const ov = Math.round(OVERLAP_S * fs);
    for (let j = 0; j + 1 < cuts.length; j++) {
      const a = Math.max(0, cuts[j] - ov), b = Math.min(len, cuts[j + 1] + ov);
      const channels = slice(ch, a, b);
      units.push({ file, fs, cuts: [cuts[j], cuts[j + 1]], start: a, first: j === 0, last: j + 2 === cuts.length, channels });
    }
  });
  for (const [k, u] of units.entries()) {
    yield { fraction: W.denoise + (W.analyze * k) / units.length, stage: '分析', file: u.file };
    u.reverbMs = decayTimeMs(u.channels, u.fs);
    u.t60est = estimateT60(u.channels, u.fs);
    u.f0 = estimateF0(u.channels, u.fs).hz;
    u.env = envelopeProfile(u.channels, u.fs);
    u.shape = spectralShape(u.channels, u.fs);
  }

  // 目标：参考文件整体，或所有单元的平均。
  const refFs = ref === null ? null : inputs[ref].sampleRate;
  const target = o.target ?? (ref === null
    ? { f0: medianOf(units.map((u) => u.f0)), env: averageOf(units.map((u) => u.env)), shape: averageShape(units.map((u) => u.shape)),
      reverbMs: medianOf(units.map((u) => u.reverbMs)), t60est: medianOf(units.map((u) => u.t60est)) }
    : { f0: estimateF0(cleaned[ref], refFs).hz, env: envelopeProfile(cleaned[ref], refFs), shape: spectralShape(cleaned[ref], refFs),
      reverbMs: decayTimeMs(cleaned[ref], refFs), t60est: estimateT60(cleaned[ref], refFs) });

  for (const [k, u] of units.entries()) {
    yield { fraction: W.denoise + W.analyze + (W.unify * k) / units.length, stage: '统一音色', file: u.file };
    let ch = u.channels;
    u.pitchSt = 0; u.formantRatio = 1; u.eqDb = null; u.t60 = 0;
    if (o.segment || u.file !== ref) {
      if (o.pitch > 0 && Number.isFinite(u.f0) && Number.isFinite(target.f0)) {
        const st = Math.max(-PITCH_MAX_ST, Math.min(PITCH_MAX_ST, semitones(target.f0, u.f0) * o.pitch));
        if (Math.abs(st) >= PITCH_MIN_ST) u.pitchSt = st;
      }
      if (o.formant > 0) {
        const a = Math.pow(estimateFormantWarp(u.env, target.env), o.formant);
        if (Math.abs(a - 1) >= FORMANT_MIN) u.formantRatio = a;
      }
      ch = shiftPitchFormant(ch, u.fs, Math.pow(2, u.pitchSt / 12), u.formantRatio);
      if (o.dereverb > 0 && roomier(u, target)) {
        u.t60 = 0.5;
        ch = dereverb(ch, u.fs, { t60: u.t60, strength: 0.7 * o.dereverb });
      }
      if (o.eq > 0) {
        u.eqDb = eqCurve(spectralShape(ch, u.fs), target.shape, { strength: o.eq, maxDb: o.eqMaxDb, snrDb: profiles[u.file].snrDb });
        ch = applyEq(ch, u.fs, u.eqDb);
      }
    }
    // 手动调音色（每个文件单独设置）：在自动统一之后施加，不会被音色匹配抵消。
    if (o.manual?.[u.file]) ch = applyManual(ch, u.fs, o.manual[u.file]);
    const r = normalizeLoudness(ch, u.fs, o);
    u.out = r.ch;
    u.limitedDb = r.limitedDb;
  }

  const outputs = [];
  for (const [file, a] of inputs.entries()) {
    yield { fraction: W.denoise + W.analyze + W.unify + (W.report * file) / n, stage: '生成结果', file };
    const fs = a.sampleRate;
    const len = a.channels[0].length;
    const mine = units.filter((u) => u.file === file);
    const ov = Math.round(OVERLAP_S * fs);
    // 拼回：相邻单元在切点两侧各 20 ms 内线性交叉淡化（切点都在停顿里）。
    const channels = a.channels.map(() => new Float32Array(len));
    for (const u of mine) {
      for (let i = 0; i < u.out[0].length; i++) {
        const s = u.start + i;
        let w = 1;
        if (!u.first && s < u.cuts[0] + ov) w = Math.max(0, Math.min(1, (s - (u.cuts[0] - ov)) / (2 * ov)));
        if (!u.last && s >= u.cuts[1] - ov) w = Math.min(w, Math.max(0, Math.min(1, (u.cuts[1] + ov - s) / (2 * ov))));
        for (let c = 0; c < channels.length; c++) channels[c][s] += w * u.out[c][i];
      }
    }
    const out = { name: a.name, sampleRate: fs, channels };
    const after = analyze(out);
    const f0Before = medianOf(mine.map((u) => u.f0));
    const f0After = estimateF0(channels, fs).hz;
    const fileTarget = o.target ? o.target.fileShape : ref === null ? averageShape(profiles.map((p) => p.shape)) : profiles[ref].shape;
    outputs.push({
      ...out,
      report: {
        name: a.name,
        isReference: file === ref,
        segments: mine.length,
        before: {
          ...before[file],
          timbreDiffDb: shapeDistance(profiles[file].shape, fileTarget, profiles[file].snrDb),
          pitchSt: semitones(f0Before, target.f0),
          reverbMs: decayTimeMs(a.channels, fs),
        },
        after: {
          ...after,
          timbreDiffDb: shapeDistance(spectralShape(channels, fs), target.shape, profiles[file].snrDb),
          pitchSt: semitones(f0After, target.f0),
          reverbMs: decayTimeMs(channels, fs),
          limiterDb: Math.min(0, ...mine.map((u) => u.limitedDb)),
        },
        // 每个单元做了什么：移了几个半音、共振峰缩放多少、EQ 曲线。
        adjustments: mine.map((u) => ({
          startS: u.cuts[0] / fs, endS: u.cuts[1] / fs, pitchSt: u.pitchSt, formantRatio: u.formantRatio, dereverbT60: u.t60, eqDb: u.eqDb,
        })),
      },
    });
  }
  return { outputs, target, options: o };
}
