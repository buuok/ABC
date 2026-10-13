import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyManual, cleanManual, isNeutral, MANUAL_CONTROLS } from '../lib/manual.mjs';
import { estimateF0, envelopeProfile, estimateFormantWarp, semitones } from '../lib/pitch.mjs';
import { bandProfile, CENTERS } from '../lib/eqmatch.mjs';
import { speechLike } from '../lib/synth.mjs';
import { createApp } from '../server.mjs';
import { encodeWav } from '../lib/wav.mjs';

const fs = 48000;
const x = [speechLike(fs, 4, { seed: 5, f0: 125 }).signal];
const f0 = estimateF0(x, fs).hz;

test('手动调音色：全为 0 时原样返回，超范围的值被限制', () => {
  assert.equal(applyManual(x, fs, { pitchSt: 0, warmDb: 0 }), x);
  assert.ok(isNeutral(undefined) && isNeutral({}));
  const c = cleanManual({ pitchSt: 99, formantPct: -99, warmDb: 'abc', evil: 1 });
  assert.deepEqual(Object.keys(c), MANUAL_CONTROLS.map((k) => k.key));
  assert.equal(c.pitchSt, 6);
  assert.equal(c.formantPct, -15);
  assert.equal(c.warmDb, 0);
});

test('嗓音粗细只动共振峰、不动音高；音调只动音高', () => {
  const y = applyManual(x, fs, { formantPct: 6 });
  assert.ok(Math.abs(semitones(estimateF0(y, fs).hz, f0)) < 0.15);
  const warp = estimateFormantWarp(envelopeProfile(x, fs), envelopeProfile(y, fs), { maxRatio: 1.3 });
  assert.ok(Math.abs(warp - 1.06) < 0.025, `共振峰缩放 ${warp}`);
  const z = applyManual(x, fs, { pitchSt: 2 });
  assert.ok(Math.abs(semitones(estimateF0(z, fs).hz, f0) - 2) < 0.15);
});

test('厚度 / 清晰度 / 明亮分别提升低频、中高频、高频', () => {
  const at = (shape, hz) => shape[CENTERS.findIndex((c) => c >= hz)];
  const base = bandProfile(x, fs).shape;
  const tilt = (s, hz) => at(s, hz) - at(s, 1000);
  for (const [key, hz] of [['warmDb', 125], ['presenceDb', 3000], ['brightDb', 10000]]) {
    const s = bandProfile(applyManual(x, fs, { [key]: 6 }), fs).shape;
    assert.ok(tilt(s, hz) - tilt(base, hz) > 3, `${key}: ${tilt(s, hz) - tilt(base, hz)}`);
  }
});

test('网页接口：试听带手动调整，只改这一段', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vu-man-'));
  const server = createApp({ outRoot: join(root, '输出'), dataDir: join(root, '数据') }).listen(0, '127.0.0.1');
  await new Promise((ok) => server.once('listening', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ids = [];
    for (const [i, s] of [[0, 1], [1, 2]]) {
      const a = { name: `段${i}`, sampleRate: 16000, channels: [speechLike(16000, 3, { seed: s, f0: 130 }).signal] };
      ids.push((await (await fetch(base + '/api/upload', { method: 'POST', headers: { 'x-filename': encodeURIComponent(a.name + '.wav') }, body: encodeWav(a, 16) })).json()).id);
    }
    const ask = (manualOne) => fetch(base + '/api/preview', { method: 'POST', body: JSON.stringify({ id: ids[1], refId: ids[0], denoise: 0.7, eq: 1, lufs: 'reference', manualOne }) }).then((r) => r.json());
    const plain = await ask(null);
    const tuned = await ask({ formantPct: 10, warmDb: 4 });
    assert.ok(tuned.outputId && plain.outputId);
    assert.ok(Math.abs(tuned.after.timbreDiffDb - plain.after.timbreDiffDb) > 0.3, `${plain.after.timbreDiffDb} → ${tuned.after.timbreDiffDb}`);
    assert.ok(Math.abs(tuned.after.lufs - plain.after.lufs) < 0.5); // 调完音色，音量仍跟主音色一样
    const wav = await fetch(base + '/api/audio/' + tuned.outputId);
    assert.equal(wav.headers.get('content-type'), 'audio/wav');
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
