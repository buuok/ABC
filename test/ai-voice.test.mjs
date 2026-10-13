import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAiVoiceSet, concatTakes } from '../lib/demo.mjs';
import { processBatch, analyze } from '../lib/pipeline.mjs';
import { estimateF0, envelopeProfile, estimateFormantWarp, shiftPitchFormant, semitones } from '../lib/pitch.mjs';
import { splitAtPauses } from '../lib/segment.mjs';
import { speechLike } from '../lib/synth.mjs';

const fs = 48000;
const takes = makeAiVoiceSet(fs, 5);

test('移调后基频变化量与设定一致（误差 < 0.15 半音）', () => {
  const x = [speechLike(fs, 4, { seed: 9, f0: 120 }).signal];
  const f = estimateF0(x, fs).hz;
  for (const st of [-3, 2]) {
    const y = shiftPitchFormant(x, fs, Math.pow(2, st / 12), 1);
    assert.ok(Math.abs(semitones(estimateF0(y, fs).hz, f) - st) < 0.15, `移调 ${st}`);
  }
});

test('共振峰缩放估计方向正确、误差在 4% 以内', () => {
  const ref = envelopeProfile([speechLike(fs, 5, { seed: 1, f0: 125 }).signal], fs);
  for (const s of [0.95, 1.06]) {
    const a = estimateFormantWarp(envelopeProfile([speechLike(fs, 5, { seed: 1, f0: 125, formantScale: s }).signal], fs), ref);
    assert.ok(Math.abs(a * s - 1) < 0.04, `缩放 ${s} 估计为 ${a}`);
  }
});

test('AI 配音四段：以第 1 段为基准后音高差 < 0.3 半音、音色差变小、响度一致', () => {
  const { outputs } = processBatch(takes, { reference: 0, pitch: 1, formant: 1 });
  for (const o of outputs.slice(1)) {
    const r = o.report;
    assert.ok(Math.abs(r.after.pitchSt) < 0.3, `${o.name} 音高差 ${r.after.pitchSt}`);
    assert.ok(r.after.timbreDiffDb < r.before.timbreDiffDb, `${o.name} 音色差 ${r.before.timbreDiffDb} → ${r.after.timbreDiffDb}`);
    assert.ok(Math.abs(r.after.lufs - -16) < 0.3);
  }
});

test('分段模式：拼好的成片在段间停顿处切成 4 段，逐段对齐后段间音高差 < 0.5 半音', () => {
  const merged = concatTakes(takes);
  assert.equal(splitAtPauses(merged.channels, fs).length - 1, 4);
  const { outputs: [m] } = processBatch([merged], { segment: true, pitch: 1, formant: 1 });
  assert.equal(m.channels[0].length, merged.channels[0].length);
  const f0s = m.report.adjustments.map((a) => estimateF0(m.channels.map((x) => x.subarray(Math.round(a.startS * fs), Math.round(a.endS * fs))), fs).hz);
  const st = f0s.map((f) => semitones(f, f0s[0]));
  assert.ok(Math.max(...st) - Math.min(...st) < 0.5, st.join(','));
  const l = m.report.adjustments.map((a) => analyze({ sampleRate: fs, channels: m.channels.map((x) => x.subarray(Math.round(a.startS * fs), Math.round(a.endS * fs))) }).lufs);
  assert.ok(Math.max(...l) - Math.min(...l) < 1, l.join(','));
});
