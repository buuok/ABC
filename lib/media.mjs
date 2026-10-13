// 视频支持：用本地 ffmpeg 提取音轨、把处理后的音频封装回视频（视频画面直接复制，不重新编码）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav, encodeWav } from './wav.mjs';

export const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.m4v', '.avi', '.webm', '.flv', '.ts', '.mts'];
export const isVideo = (file) => VIDEO_EXTS.includes(extname(file).toLowerCase());

// 查找顺序：环境变量 VOICE_UNIFY_FFMPEG → 本目录 bin/ 下的 ffmpeg → 系统 PATH。
// 打包成独立程序时，“本目录”是程序所在的文件夹。
let cached;
export function findFfmpeg() {
  if (cached !== undefined) return cached;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const local = globalThis.__VU_APP_DIR__
    ? join(globalThis.__VU_APP_DIR__, 'bin', exe)
    : fileURLToPath(new URL(`../bin/${exe}`, import.meta.url));
  const candidates = [process.env.VOICE_UNIFY_FFMPEG, local, 'ffmpeg'].filter(Boolean);
  cached = candidates.find((c) => (c === 'ffmpeg' || existsSync(c)) && spawnSync(c, ['-version']).status === 0) ?? null;
  return cached;
}

function requireFfmpeg() {
  const f = findFfmpeg();
  if (!f) throw new Error('处理视频需要 ffmpeg：请把 ffmpeg 放到 voice-unify/bin/ 文件夹，或安装到系统 PATH（见 README）');
  return f;
}

function run(args, { capture = false } = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(requireFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    const out = [], err = [];
    p.stdout.on('data', (c) => capture && out.push(c));
    p.stderr.on('data', (c) => err.push(c));
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok(Buffer.concat(out)) : fail(new Error(`ffmpeg 出错：${Buffer.concat(err).toString().trim().slice(-500)}`))));
  });
}

// 提取第一条音轨为 32 位浮点 PCM，保留原采样率和声道数。
export async function extractAudio(file) {
  const wav = await run(['-i', file, '-map', '0:a:0', '-vn', '-c:a', 'pcm_f32le', '-f', 'wav', 'pipe:1'], { capture: true });
  return decodeWav(wav);
}

// 用处理后的音频替换原视频的音轨：画面流复制，音频编码为 AAC（webm 用 Opus）。
export async function muxVideo(videoFile, audio, outFile) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-unify-'));
  try {
    const wavPath = join(dir, 'audio.wav');
    writeFileSync(wavPath, encodeWav(audio, 32));
    const webm = extname(outFile).toLowerCase() === '.webm';
    await run([
      '-i', videoFile, '-i', wavPath, '-map', '0:v?', '-map', '1:a', '-c:v', 'copy',
      ...(webm ? ['-c:a', 'libopus', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '256k']),
      '-map_metadata', '0', '-movflags', '+faststart', outFile,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 生成一段纯色测试画面的视频，配上给定的音频（演示和测试用）。
export async function makeTestVideo(color, wavPath, outFile) {
  await run([
    '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:r=25`, '-i', wavPath,
    '-shortest', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-b:a', '256k', outFile,
  ]);
}
