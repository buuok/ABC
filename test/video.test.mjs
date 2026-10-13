import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { encodeWav } from '../lib/wav.mjs';
import { makeDemoSet } from '../lib/demo.mjs';
import { findFfmpeg, makeTestVideo, extractAudio } from '../lib/media.mjs';
import { integratedLoudness } from '../lib/loudness.mjs';

test('视频：上传 3 段，选第 1 段为主音色，下载的视频音轨已统一', { skip: !findFfmpeg() && '没有 ffmpeg' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vu-test-'));
  const server = createApp({ outRoot: join(dir, '输出'), dataDir: join(dir, '数据') }).listen(0, '127.0.0.1');
  await new Promise((ok) => server.once('listening', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ids = [];
    for (const [i, a] of makeDemoSet(48000, 4).slice(0, 3).entries()) {
      const wav = join(dir, `${i}.wav`), mp4 = join(dir, `${i}.mp4`);
      writeFileSync(wav, encodeWav(a, 24));
      await makeTestVideo('gray', wav, mp4);
      const r = await fetch(base + '/api/upload', { method: 'POST', headers: { 'x-filename': encodeURIComponent(`段${i}.mp4`) }, body: readFileSync(mp4) });
      const j = await r.json();
      assert.equal(r.status, 200, j.error);
      assert.equal(j.video, true);
      ids.push(j.id);
    }
    const { jobId } = await (await fetch(base + '/api/process', { method: 'POST', body: JSON.stringify({ ids, refId: ids[0], lufs: -16, denoise: 0.7, eq: 1 }) })).json();
    let job;
    do {
      await new Promise((ok) => setTimeout(ok, 50));
      job = await (await fetch(base + '/api/job/' + jobId)).json();
    } while (job.state === 'running');
    assert.equal(job.state, 'done', job.error);
    assert.deepEqual(readdirSync(job.outDir).sort(), ['段0-统一.mp4', '段1-统一.mp4', '段2-统一.mp4']); // 已自动保存成视频
    for (const r of job.results) {
      assert.equal(r.video, true);
      const res = await fetch(base + '/api/video/' + r.outputId);
      assert.equal(res.status, 200);
      const out = join(dir, `out-${r.outputId}.mp4`);
      writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      const a = await extractAudio(out);
      const l = integratedLoudness(a.channels, a.sampleRate);
      assert.ok(Math.abs(l - -16) < 0.5, `${r.name} 输出视频响度 ${l}`);
    }
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
