import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDemoSet, speechToPauseDb } from '../lib/demo.mjs';
import { processBatch } from '../lib/pipeline.mjs';
import { denoise } from '../lib/denoise.mjs';

const set = makeDemoSet(48000, 6);
const { outputs } = processBatch(set, { reference: 0 });

test('处理后各段响度一致（差距 < 0.5 LU）且等于目标', () => {
  const l = outputs.map((o) => o.report.after.lufs);
  assert.ok(Math.max(...l) - Math.min(...l) < 0.5, l.join(','));
  l.forEach((v) => assert.ok(Math.abs(v - -16) < 0.3));
});

test('处理后峰值不超过 -1 dBFS', () => {
  outputs.forEach((o) => assert.ok(o.report.after.peakDb <= -1 + 0.01, `${o.name} ${o.report.after.peakDb}`));
});

test('降噪：每段的语音/停顿比提升至少 3 dB，噪声大的提升 8 dB 以上', () => {
  outputs.slice(1).forEach((o, k) => {
    const i = k + 1;
    const gain = speechToPauseDb(o.channels[0], set[i].pauses) - speechToPauseDb(set[i].channels[0], set[i].pauses);
    assert.ok(gain > 3, `${o.name} 只提升 ${gain.toFixed(1)} dB`);
    if (i >= 2) assert.ok(gain > 8, `${o.name} 只提升 ${gain.toFixed(1)} dB`);
  });
});

test('音色匹配让非参考录音的音色差变小', () => {
  outputs.slice(1).forEach((o) => assert.ok(o.report.after.timbreDiffDb < o.report.before.timbreDiffDb, o.name));
});

test('立体声和 44.1 kHz 也能处理，声道数和长度不变', () => {
  const [a] = makeDemoSet(44100, 3);
  const stereo = { name: 's', sampleRate: 44100, channels: [a.channels[0], a.channels[0].map((v) => v * 0.5)] };
  const { outputs: [o] } = processBatch([stereo, a], { reference: null });
  assert.equal(o.channels.length, 2);
  assert.equal(o.channels[0].length, a.channels[0].length);
});

test('降噪强度 0 时原样输出', () => {
  const x = set[1].channels;
  const y = denoise(x, 48000, { strength: 0 });
  assert.deepEqual(y[0], x[0]);
});

test('预设与“跟主音色一样响”：只统一音量时音色不变，响度等于主音色', async () => {
  const { presetSettings, PRESETS, DEFAULT_PRESET } = await import('../lib/presets.mjs');
  const { processBatchAsync } = await import('../lib/pipeline.mjs');
  assert.ok(PRESETS.some((p) => p.id === DEFAULT_PRESET));
  assert.equal(presetSettings('ai').pitch, 0); // 推荐方案不升调
  const set = makeDemoSet(16000, 3).slice(0, 3);
  const stages = [];
  const { outputs } = await processBatchAsync(set, { ...presetSettings('volume'), reference: 0, targetLufs: 'reference' }, (p) => stages.push(p));
  const refLufs = outputs[0].report.before.lufs;
  for (const o of outputs) {
    assert.ok(Math.abs(o.report.after.lufs - refLufs) < 0.3, `${o.name} ${o.report.after.lufs} vs ${refLufs}`);
    assert.ok(Math.abs(o.report.after.timbreDiffDb - o.report.before.timbreDiffDb) < 0.3);
  }
  assert.ok(stages.length > 5 && stages.at(-1).fraction === 1);
  assert.ok(stages.every((s, i) => i === 0 || s.fraction >= stages[i - 1].fraction), '进度只增不减');
});
