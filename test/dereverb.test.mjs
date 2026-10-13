import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speechLike } from '../lib/synth.mjs';
import { dereverb, decayTimeMs, estimateT60 } from '../lib/dereverb.mjs';

const fs = 48000;
const dry = speechLike(fs, 6, { seed: 4 }).signal;
// 简单的梳状反馈混响，模拟房间尾音
const wet = Float32Array.from(dry);
const D = Math.round(0.03 * fs);
for (let i = D; i < wet.length; i++) wet[i] += 0.5 * wet[i - D]; // T60 约 0.4 秒

test('混响估计：加了混响的尾音更长', () => {
  assert.ok(decayTimeMs([wet], fs) > decayTimeMs([dry], fs) + 50);
  assert.ok(estimateT60([wet], fs) > 0.2);
});

test('去混响让尾音变短、有声部分基本不变', () => {
  const y = dereverb([wet], fs, { t60: 0.5, strength: 0.7 });
  assert.ok(decayTimeMs(y, fs) < decayTimeMs([wet], fs) - 30, `${decayTimeMs([wet], fs)} → ${decayTimeMs(y, fs)}`);
  assert.ok(estimateT60(y, fs) < estimateT60([wet], fs) - 0.08);
  let e0 = 0, e1 = 0;
  for (let i = 0; i < dry.length; i++) if (Math.abs(dry[i]) > 0.1) { e0 += wet[i] ** 2; e1 += y[0][i] ** 2; }
  assert.ok(10 * Math.log10(e1 / e0) > -4, '响亮部分最多损失 4 dB');
});
