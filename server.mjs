// 本地网页界面的服务端：只监听 127.0.0.1，音频留在内存里，不访问任何外部服务。
// 处理在后台分步进行，网页轮询 /api/job/:id 显示进度；结果自动保存到输出文件夹。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, accessSync, constants } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { decodeWav, encodeWav } from './lib/wav.mjs';
import { processBatch, processBatchAsync, analyze, voiceProfile, similarity } from './lib/pipeline.mjs';
import { MANUAL_CONTROLS, cleanManual, isNeutral } from './lib/manual.mjs';
import { makeDemoSet } from './lib/demo.mjs';
import { isVideo, extractAudio, muxVideo, findFfmpeg } from './lib/media.mjs';
import { PRESETS, LOUDNESS, DEFAULT_PRESET } from './lib/presets.mjs';

const MAX_BODY = 1024 * 1024 * 1024;
const page = new URL('./public/index.html', import.meta.url);
const PROCESS_SHARE = 0.85; // 进度条里“处理”占 85%，“保存”占 15%

// 独立版：结果放在程序旁边的“输出”文件夹；程序目录不可写或开发时放到用户目录下。
function defaultDirs() {
  const app = globalThis.__VU_APP_DIR__;
  let base = join(homedir(), '声音统一');
  if (app) {
    try { accessSync(app, constants.W_OK); base = app; } catch { /* 用用户目录 */ }
  }
  return { outRoot: process.env.VOICE_UNIFY_OUT ?? join(base, '输出'), dataDir: process.env.VOICE_UNIFY_DATA ?? join(base, '数据') };
}

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const safeName = (s) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'audio';

function openFolder(dir) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [dir]]
    : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref(); } catch { /* 打不开就算了，页面上有路径 */ }
}

// JSON 里 NaN 存成 null，读回来还原。
const revive = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => (x === null ? NaN : x)) : v === null ? NaN : v]));

export function createApp(dirs = defaultDirs()) {
  const { outRoot, dataDir } = dirs;
  const store = new Map(); // id -> { name, sampleRate, channels, source?（原视频路径）, wav?, savedPath? }
  const jobs = new Map();
  let running = null;
  const work = mkdtempSync(join(tmpdir(), 'voice-unify-ui-'));
  const voicesFile = join(dataDir, '常用主音色.json');
  const loadVoices = () => { try { return JSON.parse(readFileSync(voicesFile, 'utf8')); } catch { return []; } };
  const saveVoices = (v) => { mkdirSync(dataDir, { recursive: true }); writeFileSync(voicesFile, JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? null : x))); };

  const put = (audio) => {
    const id = randomUUID();
    store.set(id, audio);
    return { id, name: audio.name, ...analyze(audio) };
  };

  const readBody = (req) => new Promise((ok, fail) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(new Error('文件太大')); req.destroy(); } else parts.push(c);
    });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', fail);
  });

  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));
  };

  // 从网页请求组装批处理参数；manual 是 { 文件 id: 手动调音色设置 }。
  function batchFrom(body, map = (a) => a) {
    const inputs = body.ids.map((id) => {
      const a = store.get(id);
      if (!a) throw new Error('找不到已添加的文件，请重新添加');
      return map(a);
    });
    let target;
    if (body.voiceId) {
      const v = loadVoices().find((x) => x.id === body.voiceId);
      if (!v) throw new Error('找不到这个常用主音色');
      target = revive(v.profile);
    }
    const reference = !target && body.refId ? body.ids.indexOf(body.refId) : -1;
    const lufs = body.lufs === 'reference' ? 'reference' : Number(body.lufs ?? -16);
    const manual = body.ids.map((id) => (body.manual?.[id] && !isNeutral(body.manual[id]) ? cleanManual(body.manual[id]) : null));
    const opts = {
      targetLufs: lufs, denoise: Number(body.denoise ?? 0.7), eq: Number(body.eq ?? 1), dereverb: Number(body.dereverb ?? 1),
      pitch: Number(body.pitch ?? 0), formant: Number(body.formant ?? 0), segment: Boolean(body.segment),
      reference: reference === -1 ? null : reference, target, manual: manual.some(Boolean) ? manual : undefined,
    };
    return { inputs, opts };
  }

  async function runJob(job, inputs, ids, opts) {
    const { outputs } = await processBatchAsync(inputs, opts, (p) => {
      Object.assign(job, { fraction: p.fraction * PROCESS_SHARE, stage: p.stage, file: p.file });
    });
    const dir = join(outRoot, stamp());
    mkdirSync(dir, { recursive: true });
    const used = new Set();
    job.results = [];
    for (const [i, o] of outputs.entries()) {
      Object.assign(job, { fraction: PROCESS_SHARE + ((1 - PROCESS_SHARE) * i) / outputs.length, stage: '保存', file: i });
      const source = inputs[i].source;
      const ext = source ? extname(source) : '.wav';
      let base = `${safeName(o.name)}-统一`;
      for (let k = 2; used.has(base); k++) base = `${safeName(o.name)}-统一-${k}`;
      used.add(base);
      const out = { name: o.name, sampleRate: o.sampleRate, channels: o.channels, source, savedPath: join(dir, base + ext) };
      if (source) {
        await muxVideo(source, o, out.savedPath);
      } else {
        out.wav = encodeWav(o, 24);
        writeFileSync(out.savedPath, out.wav);
      }
      const id = randomUUID();
      store.set(id, out);
      job.results.push({ inputId: ids[i], outputId: id, video: Boolean(source), file: base + ext, ...o.report });
    }
    Object.assign(job, { state: 'done', fraction: 1, stage: '完成', file: null, outDir: dir, seconds: (Date.now() - job.started) / 1000 });
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/') {
        const html = globalThis.__VU_PAGE__ ?? readFileSync(page);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html); // 打包成独立程序时页面内嵌在程序里
      } else if (req.method === 'GET' && path === '/api/info') {
        json(res, 200, { ffmpeg: Boolean(findFfmpeg()), outRoot, presets: PRESETS, loudness: LOUDNESS, defaultPreset: DEFAULT_PRESET, manualControls: MANUAL_CONTROLS });
      } else if (req.method === 'POST' && path === '/api/upload') {
        const filename = decodeURIComponent(req.headers['x-filename'] ?? 'audio');
        const name = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
        const body = await readBody(req);
        if (body.toString('ascii', 0, 4) === 'RIFF') {
          json(res, 200, put({ name, ...decodeWav(body) }));
        } else {
          // 视频或压缩音频：存到临时目录，用 ffmpeg 提取音轨。
          const file = join(work, `${randomUUID()}${extname(filename).toLowerCase() || '.bin'}`);
          writeFileSync(file, body);
          const audio = await extractAudio(file);
          json(res, 200, { ...put({ name, source: isVideo(filename) ? file : null, ...audio }), video: isVideo(filename) });
        }
      } else if (req.method === 'DELETE' && path.startsWith('/api/item/')) {
        store.delete(path.slice('/api/item/'.length));
        json(res, 200, { ok: true });
      } else if (req.method === 'POST' && path === '/api/demo') {
        json(res, 200, makeDemoSet().map(({ name, sampleRate, channels }) => put({ name, sampleRate, channels })));
      } else if (req.method === 'POST' && path === '/api/process') {
        if (running) return json(res, 409, { error: '上一批还在处理，请等它完成' });
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const { inputs, opts } = batchFrom(body);
        const job = { id: randomUUID(), state: 'running', fraction: 0, stage: '准备', file: null, total: inputs.length, started: Date.now() };
        jobs.set(job.id, job);
        running = job;
        runJob(job, inputs, body.ids, opts)
          .catch((e) => Object.assign(job, { state: 'error', error: e.message }))
          .finally(() => { running = null; });
        json(res, 200, { jobId: job.id });
      } else if (req.method === 'POST' && path === '/api/preview') {
        // 试听一个文件的处理效果（含手动调音色）。只处理它和主音色这两段，长文件只取前 30 秒。
        if (running) return json(res, 409, { error: '正在批量处理，请等它完成后再试听' });
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const ids = body.refId && body.refId !== body.id && !body.voiceId ? [body.refId, body.id] : [body.id];
        const clip = (a) => ({ ...a, channels: a.channels.map((x) => x.subarray(0, Math.min(x.length, 30 * a.sampleRate))) });
        const { inputs, opts } = batchFrom({ ...body, ids, manual: { [body.id]: body.manualOne } }, clip);
        const { outputs } = processBatch(inputs, opts);
        const o = outputs[ids.indexOf(body.id)];
        const id = randomUUID();
        store.set(id, { name: o.name, sampleRate: o.sampleRate, channels: o.channels });
        json(res, 200, { outputId: id, ...o.report });
      } else if (req.method === 'GET' && path.startsWith('/api/job/')) {
        const job = jobs.get(path.slice('/api/job/'.length));
        if (!job) return json(res, 404, { error: '找不到这个任务' });
        json(res, 200, job);
      } else if (req.method === 'POST' && path === '/api/open-output') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const dir = resolve(body.dir ?? outRoot);
        if (dir !== resolve(outRoot) && !dir.startsWith(resolve(outRoot) + sep)) return json(res, 400, { error: '只能打开输出文件夹' });
        mkdirSync(dir, { recursive: true });
        openFolder(dir);
        json(res, 200, { ok: true, dir });
      } else if (req.method === 'POST' && path === '/api/similarity') {
        // 和主音色有多像（0–100 分）。每段的特征只算一次，缓存在内存里。
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const profileOf = (id) => {
          const a = store.get(id);
          if (!a) throw new Error('找不到已添加的文件，请重新添加');
          a.profile ??= voiceProfile(a);
          return a.profile;
        };
        let target;
        if (body.voiceId) {
          const v = loadVoices().find((x) => x.id === body.voiceId);
          if (!v) throw new Error('找不到这个常用主音色');
          target = revive(v.profile);
        } else if (body.refId) target = profileOf(body.refId);
        else throw new Error('先选一个主音色');
        json(res, 200, body.ids.map((id) => ({ id, ...similarity(profileOf(id), target) })));
      } else if (req.method === 'GET' && path === '/api/voices') {
        json(res, 200, loadVoices().map(({ id, name, created }) => ({ id, name, created })));
      } else if (req.method === 'POST' && path === '/api/voices') {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const a = store.get(body.fromId);
        if (!a) throw new Error('找不到这段录音，请重新添加');
        const name = String(body.name || a.name).slice(0, 60);
        const voices = loadVoices().filter((v) => v.name !== name); // 同名覆盖
        const v = { id: randomUUID(), name, created: new Date().toISOString(), profile: voiceProfile(a, { denoise: Number(body.denoise ?? 0.7) }) };
        saveVoices([...voices, v]);
        json(res, 200, { id: v.id, name: v.name, created: v.created });
      } else if (req.method === 'DELETE' && path.startsWith('/api/voices/')) {
        const id = path.slice('/api/voices/'.length);
        saveVoices(loadVoices().filter((v) => v.id !== id));
        json(res, 200, { ok: true });
      } else if (req.method === 'GET' && path.startsWith('/api/audio/')) {
        const a = store.get(path.slice('/api/audio/'.length));
        if (!a) return json(res, 404, { error: '找不到音频' });
        a.wav ??= encodeWav(a, 24);
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.name)}.wav`,
        });
        res.end(a.wav);
      } else if (req.method === 'GET' && path.startsWith('/api/video/')) {
        const a = store.get(path.slice('/api/video/'.length));
        if (!a?.source) return json(res, 404, { error: '找不到视频' });
        const ext = extname(a.source);
        a.savedPath ??= join(work, `${randomUUID()}${ext}`);
        if (!existsSync(a.savedPath)) await muxVideo(a.source, a, a.savedPath);
        const data = readFileSync(a.savedPath);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="video${ext}"; filename*=UTF-8''${encodeURIComponent(a.name + '-统一' + ext)}`,
        });
        res.end(data);
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      // 已经开始回应时不能再发错误信息，只断开这一个请求，程序本身继续运行。
      if (res.headersSent) res.destroy(e);
      else json(res, 400, { error: e.message });
    }
  });
  server.on('close', () => rmSync(work, { recursive: true, force: true }));
  return server;
}

// 端口被占用（比如已经开着一个）时自动换一个空闲端口。
export function startServer(port = 8765) {
  return new Promise((ok, fail) => {
    const app = createApp();
    const onListening = () => {
      const addr = `http://127.0.0.1:${app.address().port}`;
      console.log(`界面已启动：${addr}  （在浏览器中打开；按 Ctrl+C 退出）`);
      console.log(findFfmpeg() ? '已找到 ffmpeg，可以处理视频。' : '未找到 ffmpeg：只能处理音频，处理视频请见 README。');
      console.log(`处理结果会自动保存到：${defaultDirs().outRoot}`);
      process.once('SIGINT', () => { app.close(); process.exit(0); });
      ok({ server: app, url: addr });
    };
    app.once('error', (e) => {
      if (e.code !== 'EADDRINUSE' || port === 0) return fail(e);
      app.listen(0, '127.0.0.1', onListening);
    });
    app.listen(port, '127.0.0.1', onListening);
  });
}
