import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { encodeWav } from '../lib/wav.mjs';
import { makeDemoSet } from '../lib/demo.mjs';

async function waitJob(base, jobId) {
  const seen = new Set();
  for (;;) {
    const job = await (await fetch(`${base}/api/job/${jobId}`)).json();
    seen.add(job.stage);
    if (job.state !== 'running') return { job, seen };
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

test('网页接口：批量上传、后台处理带进度、自动保存、常用主音色', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vu-test-'));
  const server = createApp({ outRoot: join(root, '输出'), dataDir: join(root, '数据') }).listen(0, '127.0.0.1');
  await new Promise((ok) => server.once('listening', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.match(await (await fetch(base + '/')).text(), /声音统一/);
    const info = await (await fetch(base + '/api/info')).json();
    assert.ok(info.presets.some((p) => p.id === info.defaultPreset));
    const set = makeDemoSet(16000, 3).slice(0, 3);
    const ids = [];
    for (const a of set) {
      const r = await fetch(base + '/api/upload', { method: 'POST', headers: { 'x-filename': encodeURIComponent(a.name + '.wav') }, body: encodeWav(a, 16) });
      const j = await r.json();
      assert.equal(r.status, 200, j.error);
      ids.push(j.id);
    }
    const r = await fetch(base + '/api/process', { method: 'POST', body: JSON.stringify({ ids, refId: ids[0], lufs: 'reference', denoise: 0.7, eq: 1 }) });
    const { jobId } = await r.json();
    assert.ok(jobId);
    const busy = await fetch(base + '/api/process', { method: 'POST', body: JSON.stringify({ ids, refId: ids[0] }) });
    assert.equal(busy.status, 409); // 同时只跑一批
    const { job, seen } = await waitJob(base, jobId);
    assert.equal(job.state, 'done', job.error);
    assert.ok(seen.has('统一音色') || seen.has('保存'), [...seen].join(','));
    assert.equal(job.results.length, 3);
    // 音量跟主音色一样
    for (const res of job.results) assert.ok(Math.abs(res.after.lufs - job.results[0].before.lufs) < 0.5, `${res.after.lufs}`);
    assert.deepEqual(readdirSync(job.outDir).sort(), set.map((a) => `${a.name}-统一.wav`).sort());
    const wav = await fetch(base + '/api/audio/' + job.results[1].outputId);
    assert.equal(wav.headers.get('content-type'), 'audio/wav');

    // 像不像主音色：主音色自己 100 分，其他段分数在 0–100
    const sim = await (await fetch(base + '/api/similarity', { method: 'POST', body: JSON.stringify({ ids, refId: ids[0] }) })).json();
    assert.equal(sim[0].score, 100);
    assert.ok(sim.slice(1).every((s) => s.score >= 0 && s.score < 100));

    // 存为常用主音色，下一批只带新文件
    const v = await (await fetch(base + '/api/voices', { method: 'POST', body: JSON.stringify({ fromId: ids[0], name: '主播' }) })).json();
    assert.deepEqual((await (await fetch(base + '/api/voices')).json()).map((x) => x.name), ['主播']);
    const r2 = await fetch(base + '/api/process', { method: 'POST', body: JSON.stringify({ ids: ids.slice(1), voiceId: v.id, lufs: 'reference' }) });
    const { job: job2 } = await waitJob(base, (await r2.json()).jobId);
    assert.equal(job2.state, 'done', job2.error);
    // 用存下来的主音色，结果应当和带着那段录音一起处理时一样
    for (const [i, x] of job2.results.entries()) {
      assert.ok(!x.isReference);
      assert.ok(Math.abs(x.after.timbreDiffDb - job.results[i + 1].after.timbreDiffDb) < 0.1, `${x.name}: ${x.after.timbreDiffDb} vs ${job.results[i + 1].after.timbreDiffDb}`);
    }
    await fetch(base + '/api/voices/' + v.id, { method: 'DELETE' });
    assert.deepEqual(await (await fetch(base + '/api/voices')).json(), []);

    const bad = await fetch(base + '/api/upload', { method: 'POST', body: 'not audio' });
    assert.equal(bad.status, 400);
    const outside = await fetch(base + '/api/open-output', { method: 'POST', body: JSON.stringify({ dir: root }) });
    assert.equal(outside.status, 400);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
