import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFFT } from '../lib/fft.mjs';
import { processFrames, frameSizeFor } from '../lib/stft.mjs';
import { integratedLoudness } from '../lib/loudness.mjs';
import { decodeWav, encodeWav } from '../lib/wav.mjs';
import { limit } from '../lib/limiter.mjs';

const sine = (fs, f, amp, seconds) => Float32Array.from({ length: fs * seconds }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / fs));

test('FFT 正反变换还原原信号', () => {
  const fft = makeFFT(64);
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + i / 10);
  const im = new Float64Array(64);
  const orig = Float64Array.from(re);
  fft.transform(re, im);
  fft.transform(re, im, true);
  re.forEach((v, i) => assert.ok(Math.abs(v - orig[i]) < 1e-9));
});

test('STFT 单位增益时完美重建', () => {
  for (const fs of [16000, 44100, 48000]) {
    const x = Float32Array.from({ length: fs }, (_, i) => Math.sin(i * 0.01) * 0.3 + Math.sin(i * 0.37) * 0.2);
    const [y] = processFrames([x], frameSizeFor(fs), () => {});
    let err = 0;
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(x[i] - y[i]));
    assert.ok(err < 1e-5, `fs=${fs} 误差 ${err}`);
  }
});

test('响度：1 kHz、-20 dBFS 正弦约为 -23 LUFS（BS.1770）', () => {
  for (const fs of [44100, 48000]) {
    const l = integratedLoudness([sine(fs, 997, 0.1, 5)], fs);
    assert.ok(Math.abs(l - -23.01) < 0.1, `fs=${fs} 得到 ${l}`);
  }
  const fs = 48000;
  const s = sine(fs, 997, 0.1, 5);
  assert.ok(Math.abs(integratedLoudness([s, s], fs) - -20.0) < 0.1, '双声道各加 3 dB');
});

test('WAV 编解码往返', () => {
  const fs = 22050;
  const ch = [sine(fs, 440, 0.5, 1), sine(fs, 660, -0.25, 1)];
  for (const bits of [16, 24, 32]) {
    const back = decodeWav(encodeWav({ sampleRate: fs, channels: ch }, bits));
    assert.equal(back.sampleRate, fs);
    assert.equal(back.channels.length, 2);
    const tol = bits === 16 ? 1e-4 : 1e-6;
    for (let c = 0; c < 2; c++) for (let i = 0; i < 1000; i++) assert.ok(Math.abs(back.channels[c][i] - ch[c][i]) < tol);
  }
});

test('限制器保证峰值不超过上限', () => {
  const fs = 48000;
  const x = sine(fs, 200, 1.5, 1);
  const { channels } = limit([x], fs, -1);
  const ceiling = Math.pow(10, -1 / 20);
  assert.ok(channels[0].every((v) => Math.abs(v) <= ceiling + 1e-6));
});
