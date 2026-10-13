#!/usr/bin/env node
// 命令行入口：process / analyze / demo / ui
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { decodeWav, encodeWav } from './lib/wav.mjs';
import { processBatch, analyze, DEFAULTS } from './lib/pipeline.mjs';
import { makeDemoSet, makeAiVoiceSet, concatTakes, speechToPauseDb } from './lib/demo.mjs';
import { estimateF0, semitones } from './lib/pitch.mjs';
import { startServer } from './server.mjs';
import { isVideo, extractAudio, muxVideo, makeTestVideo } from './lib/media.mjs';
import { PRESETS, presetSettings } from './lib/presets.mjs';
import { MANUAL_CONTROLS, cleanManual } from './lib/manual.mjs';

const HELP = `voice-unify：离线统一多段录音的音量、音色并降噪

用法:
  node cli.mjs ui [--port 8765]               打开本地网页界面（推荐）
  node cli.mjs process a.mp4 b.mp4 c.wav ... -o 输出目录 [选项]   （视频需要 ffmpeg）
  node cli.mjs analyze a.wav b.wav ...        只看响度、峰值、估计信噪比
  node cli.mjs demo [-o demo] [--video|--ai]  生成合成测试音频并处理，打印前后指标；
                                              --video 走视频流程，--ai 模拟 AI 配音各段音色不一致

process 选项:
  --preset <名称>        一键预设：${PRESETS.map((p) => p.id).join(' / ')}（ai 为推荐），其余选项可在预设基础上再改
  --ref <文件名或序号>   以哪段录音的音色为基准（默认：所有录音的平均音色）
  --lufs <数值|ref>      目标响度，默认 ${DEFAULTS.targetLufs}（播客 -16，广播 -23，流媒体 -14）；ref 表示跟基准一样响
  --denoise <0~1>        降噪强度，默认 ${DEFAULTS.denoise}，0 为关闭
  --dereverb <0~1>       混响对齐强度，默认 ${DEFAULTS.dereverb}：比基准“空”的段落去掉多出来的混响，0 为关闭
  --eq <0~1>             音色匹配强度，默认 ${DEFAULTS.eq}，0 为关闭
  --pitch <0~1>          音高对齐强度，默认 ${DEFAULTS.pitch}（关闭）；音高明显不同又想拉齐时设为 1
  --formant <0~1>        共振峰对齐强度，默认 ${DEFAULTS.formant}（关闭）
  --tune <序号>:<设置>   手动调音色（可写多次），如 --tune 3:formantPct=6,warmDb=-2；
                         可调：${MANUAL_CONTROLS.map((c) => `${c.key}（${c.name}，${c.min}~${c.max} ${c.unit}）`).join('、')}
  --segment              分段模式：在停顿处切开，每句单独对齐（适合已经拼好的成片）
  --peak <dBFS>          峰值上限，默认 ${DEFAULTS.peakDb}
  --bits <16|24|32>      输出位深，默认 24（32 为浮点）
`;

const fmt = (v, d = 1) => (Number.isFinite(v) ? (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d) : '—');

function printTable(rows, extraCols = []) {
  const head = ['文件', '响度 前→后 (LUFS)', '估计信噪比 前→后 (dB)', '音色差 前→后 (dB)', '音高差 前→后 (半音)', '混响尾音 前→后 (ms)', ...extraCols.map((c) => c.title)];
  const lines = rows.map(({ report: r }, i) => [
    r.name + (r.isReference ? ' [参考]' : ''),
    `${fmt(r.before.lufs)} → ${fmt(r.after.lufs)}`,
    `${fmt(r.before.snrDb)} → ${fmt(r.after.snrDb)}`,
    `${fmt(r.before.timbreDiffDb)} → ${fmt(r.after.timbreDiffDb)}`,
    `${fmt(r.before.pitchSt)} → ${fmt(r.after.pitchSt)}`,
    `${fmt(r.before.reverbMs, 0)} → ${fmt(r.after.reverbMs, 0)}`,
    ...extraCols.map((c) => c.value(i)),
  ]);
  const all = [head, ...lines];
  const width = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const widths = head.map((_, c) => Math.max(...all.map((l) => width(l[c]))));
  for (const l of all) console.log(l.map((cell, c) => cell + ' '.repeat(widths[c] - width(cell))).join('  '));
  const spread = (k) => {
    const v = rows.map((r) => r.report[k].lufs).filter(Number.isFinite);
    return Math.max(...v) - Math.min(...v);
  };
  console.log(`\n响度差距（最大−最小）：处理前 ${fmt(spread('before'))} LU → 处理后 ${fmt(spread('after'))} LU`);
}

// WAV 直接读；视频和其他音频格式（mp3、m4a…）交给 ffmpeg 提取。
async function loadInputs(files) {
  const out = [];
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    const audio = ext === '.wav' ? decodeWav(readFileSync(f)) : await extractAudio(f);
    out.push({ name: basename(f, ext), source: isVideo(f) ? resolve(f) : null, ...audio });
  }
  return out;
}

async function writeOutputs(outputs, dir, bits, sources = []) {
  mkdirSync(dir, { recursive: true });
  for (const [i, o] of outputs.entries()) {
    const src = sources[i];
    if (src) {
      const file = join(dir, `${o.name}${extname(src)}`);
      await muxVideo(src, o, file);
      console.log(`已写入视频 ${file}`);
    } else {
      writeFileSync(join(dir, `${o.name}.wav`), encodeWav(o, bits));
    }
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' }, ref: { type: 'string' }, lufs: { type: 'string' },
      denoise: { type: 'string' }, dereverb: { type: 'string' }, eq: { type: 'string' }, peak: { type: 'string' },
      bits: { type: 'string' }, port: { type: 'string' }, video: { type: 'boolean' }, ai: { type: 'boolean' },
      segment: { type: 'boolean' }, pitch: { type: 'string' }, formant: { type: 'string' }, preset: { type: 'string' },
      tune: { type: 'string', multiple: true },
    },
  });
  const bits = Number(values.bits ?? 24);
  const opts = {
    ...(values.preset !== undefined && presetSettings(values.preset)),
    ...(values.lufs !== undefined && { targetLufs: /^ref/i.test(values.lufs) ? 'reference' : Number(values.lufs) }),
    ...(values.denoise !== undefined && { denoise: Number(values.denoise) }),
    ...(values.dereverb !== undefined && { dereverb: Number(values.dereverb) }),
    ...(values.eq !== undefined && { eq: Number(values.eq) }),
    ...(values.peak !== undefined && { peakDb: Number(values.peak) }),
    ...(values.pitch !== undefined && { pitch: Number(values.pitch) }),
    ...(values.formant !== undefined && { formant: Number(values.formant) }),
    ...(values.segment && { segment: true }),
  };

  if (cmd === 'ui') {
    await startServer(Number(values.port ?? 8765));
  } else if (cmd === 'analyze') {
    for (const a of await loadInputs(positionals)) {
      const r = analyze(a);
      console.log(`${a.name}: ${fmt(r.seconds)} 秒, ${fmt(r.lufs)} LUFS, 峰值 ${fmt(r.peakDb)} dBFS, 估计信噪比 ${fmt(r.snrDb)} dB`);
    }
  } else if (cmd === 'process') {
    if (!positionals.length || !values.out) { console.log(HELP); process.exit(1); }
    const inputs = await loadInputs(positionals);
    if (values.ref !== undefined) {
      const byIndex = /^\d+$/.test(values.ref) ? Number(values.ref) - 1 : -1;
      opts.reference = byIndex >= 0 ? byIndex : inputs.findIndex((a) => a.name === basename(values.ref, extname(values.ref)));
      if (opts.reference < 0 || opts.reference >= inputs.length) throw new Error(`找不到参考文件：${values.ref}`);
    }
    if (values.tune) {
      opts.manual = inputs.map(() => null);
      for (const t of values.tune) {
        const m = /^(\d+):(.+)$/.exec(t);
        const i = m ? Number(m[1]) - 1 : -1;
        if (i < 0 || i >= inputs.length) throw new Error(`--tune 格式应为 序号:设置，如 3:formantPct=6，收到：${t}`);
        const set = Object.fromEntries(m[2].split(',').map((kv) => kv.split('=').map((x) => x.trim())));
        const bad = Object.keys(set).filter((k) => !MANUAL_CONTROLS.some((c) => c.key === k));
        if (bad.length) throw new Error(`不认识的调音色项：${bad.join(', ')}`);
        opts.manual[i] = cleanManual(set);
      }
    }
    const { outputs } = processBatch(inputs, opts);
    await writeOutputs(outputs, values.out, bits, inputs.map((a) => a.source));
    printTable(outputs);
    console.log(`\n已写入 ${outputs.length} 个文件到 ${resolve(values.out)}`);
  } else if (cmd === 'demo' && values.ai) {
    await aiDemo(values.out ?? 'demo-ai', opts);
  } else if (cmd === 'demo' && values.video) {
    await videoDemo(values.out ?? 'demo-video', opts);
  } else if (cmd === 'demo') {
    const dir = values.out ?? 'demo';
    const set = makeDemoSet();
    await writeOutputs(set, join(dir, 'input'), 24);
    await writeOutputs(set.map((s) => ({ name: s.name, sampleRate: s.sampleRate, channels: [s.clean] })), join(dir, 'clean'), 24);
    const t0 = performance.now();
    const { outputs } = processBatch(set, { reference: 0, ...opts });
    const ms = performance.now() - t0;
    await writeOutputs(outputs, join(dir, 'output'), 24);
    const truth = outputs.map((o, i) => ({
      before: speechToPauseDb(set[i].channels[0], set[i].pauses),
      after: speechToPauseDb(o.channels[0], set[i].pauses),
    }));
    printTable(outputs, [{ title: '语音/停顿比 前→后 (dB)', value: (i) => `${fmt(truth[i].before)} → ${fmt(truth[i].after)}` }]);
    console.log(`\n处理 ${set.length} 段共 ${fmt(set.length * 8, 0)} 秒音频用时 ${fmt(ms / 1000, 2)} 秒`);
    writeFileSync(join(dir, 'report.json'), JSON.stringify(outputs.map((o, i) => ({ ...o.report, truth: truth[i] })), null, 2));
    console.log(`试听文件在 ${resolve(dir)}/{input,output,clean}，指标见 report.json`);
  } else {
    console.log(HELP);
  }
}

// AI 配音演示：① 四个独立片段以第 1 段为主音色；② 同样四段拼成一个文件，用分段模式处理。
async function aiDemo(dir, opts) {
  const takes = makeAiVoiceSet();
  await writeOutputs(takes, join(dir, 'input'), 24);
  const { outputs } = processBatch(takes, { reference: 0, pitch: 1, formant: 1, ...opts });
  await writeOutputs(outputs, join(dir, 'output'), 24);
  console.log('① 四个独立片段，以 01-主音色 为基准：\n');
  printTable(outputs);

  const merged = concatTakes(takes);
  await writeOutputs([merged], join(dir, 'input'), 24);
  const { outputs: [m] } = processBatch([merged], { pitch: 1, formant: 1, ...opts, segment: true, reference: null });
  await writeOutputs([m], join(dir, 'output'), 24);
  const fs = merged.sampleRate;
  const segStats = (ch) => m.report.adjustments.map((a) => {
    const part = ch.map((x) => x.subarray(Math.round(a.startS * fs), Math.round(a.endS * fs)));
    return { f0: estimateF0(part, fs).hz, lufs: analyze({ sampleRate: fs, channels: part }).lufs };
  });
  const b = segStats(merged.channels), af = segStats(m.channels);
  const spread = (arr, f) => { const v = arr.map(f).filter(Number.isFinite); return Math.max(...v) - Math.min(...v); };
  console.log(`\n② 拼好的成片（分段模式，向各段平均对齐），自动切成 ${m.report.segments} 段：`);
  m.report.adjustments.forEach((a, i) => console.log(
    `  第 ${i + 1} 段 ${fmt(a.startS)}–${fmt(a.endS)} 秒：移调 ${fmt(a.pitchSt, 2)} 半音，共振峰 ×${fmt(a.formantRatio, 3)}，响度 ${fmt(b[i].lufs)} → ${fmt(af[i].lufs)} LUFS`));
  console.log(`  段间音高差距（最高−最低）：${fmt(spread(b, (s) => semitones(s.f0, 100)), 2)} → ${fmt(spread(af, (s) => semitones(s.f0, 100)), 2)} 半音`);
  console.log(`  段间响度差距：${fmt(spread(b, (s) => s.lufs))} → ${fmt(spread(af, (s) => s.lufs))} LU`);
  console.log(`\n试听文件在 ${resolve(dir)}/{input,output}`);
}

// 视频演示：前三个场景各配一段彩色测试画面封装成 mp4，以第 1 段为主音色处理，输出视频。
async function videoDemo(dir, opts) {
  const set = makeDemoSet().slice(0, 3);
  await writeOutputs(set, join(dir, 'tmp-audio'), 24);
  mkdirSync(join(dir, 'input'), { recursive: true });
  const colors = ['steelblue', 'darkolivegreen', 'sienna'];
  const files = [];
  for (const [i, s] of set.entries()) {
    const file = join(dir, 'input', `${s.name}.mp4`);
    files.push(file);
    await makeTestVideo(colors[i], join(dir, 'tmp-audio', `${s.name}.wav`), file);
  }
  rmSync(join(dir, 'tmp-audio'), { recursive: true, force: true });
  const inputs = await loadInputs(files);
  const { outputs } = processBatch(inputs, { reference: 0, ...opts });
  await writeOutputs(outputs, join(dir, 'output'), 24, inputs.map((a) => a.source));
  // 从输出视频里重新提取音频测一遍，确认封装后的音轨就是处理结果。
  const check = await loadInputs(outputs.map((o, i) => join(dir, 'output', `${o.name}${extname(files[i])}`)));
  printTable(outputs);
  console.log('\n从输出视频重新测得的响度：' + check.map((c) => `${c.name} ${fmt(analyze(c).lufs)} LUFS`).join('，'));
}

main().catch((e) => { console.error(`错误：${e.message}`); process.exit(1); });
