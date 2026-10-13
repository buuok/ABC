// 一键预设：给不想调参数的人用。网页界面和命令行（--preset）共用。
// 默认 ai：用户 2026-10-10 试听后选定的“B 不升调”方案，音量跟主音色一样响。
export const PRESETS = [
  {
    id: 'ai', name: 'AI 配音统一（推荐）',
    desc: '同一个 AI 声音、不同次生成的片段听起来不一样时用。统一音色、去底噪和多余混响，不改音高。',
    settings: { denoise: 0.7, dereverb: 1, eq: 1, pitch: 0, formant: 0, segment: false },
  },
  {
    id: 'light', name: '轻度统一（保留原味）',
    desc: '各段本来就差不多，只想稍微拉近一点，尽量不改变声音。',
    settings: { denoise: 0.4, dereverb: 1, eq: 0.6, pitch: 0, formant: 0, segment: false },
  },
  {
    id: 'noisy', name: '嘈杂录音（强降噪）',
    desc: '有明显底噪、风扇声、电流声的录音。降噪更强，人声可能略微发闷。',
    settings: { denoise: 0.9, dereverb: 1, eq: 1, pitch: 0, formant: 0, segment: false },
  },
  {
    id: 'volume', name: '只统一音量',
    desc: '只把音量调成一样大，其他什么都不动。',
    settings: { denoise: 0, dereverb: 0, eq: 0, pitch: 0, formant: 0, segment: false },
  },
  {
    id: 'segment', name: '已拼好的成片（逐句统一）',
    desc: '一个文件里前后几句声音不一样时用。会在停顿处切开，每句单独向主音色靠拢。',
    settings: { denoise: 0.7, dereverb: 1, eq: 1, pitch: 0, formant: 0, segment: true },
  },
  {
    id: 'strong', name: '强力统一（连音高一起拉齐）',
    desc: '音高也明显不同时才用。会改变音高和嗓音粗细，可能不如推荐方案自然。',
    settings: { denoise: 0.7, dereverb: 1, eq: 1, pitch: 1, formant: 1, segment: false },
  },
];

// 音量选项：'reference' 表示跟主音色一样响（没有主音色时取各段中间值）。
export const LOUDNESS = [
  { value: 'reference', name: '跟主音色一样响（推荐）' },
  { value: -16, name: '-16 LUFS（视频 / 播客）' },
  { value: -14, name: '-14 LUFS（短视频平台，更响）' },
  { value: -23, name: '-23 LUFS（广播电视）' },
];

export const DEFAULT_PRESET = 'ai';

export function presetSettings(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`没有这个预设：${id}（可选：${PRESETS.map((x) => x.id).join(' / ')}）`);
  return { ...p.settings };
}
