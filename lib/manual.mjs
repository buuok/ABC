// 手动调音色：像常见变声软件那样，用几个滑块按耳朵调，不用 AI。
// 在自动统一之后、音量标准化之前施加，所以不会被自动的音色匹配抵消。
import { design, filter } from './biquad.mjs';
import { shiftPitchFormant } from './pitch.mjs';

// 滑块定义：网页界面和命令行共用。
export const MANUAL_CONTROLS = [
  { key: 'pitchSt', name: '音调', unit: '半音', min: -6, max: 6, step: 0.5, low: '更低', high: '更高' },
  { key: 'formantPct', name: '嗓音粗细', unit: '%', min: -15, max: 15, step: 1, low: '更粗厚', high: '更细' },
  { key: 'warmDb', name: '厚度（低频）', unit: 'dB', min: -8, max: 8, step: 0.5, low: '更薄', high: '更厚' },
  { key: 'presenceDb', name: '清晰度（中高频）', unit: 'dB', min: -8, max: 8, step: 0.5, low: '更柔', high: '更清楚' },
  { key: 'brightDb', name: '明亮（高频）', unit: 'dB', min: -8, max: 8, step: 0.5, low: '更暗', high: '更亮' },
];

export const isNeutral = (m) => !m || MANUAL_CONTROLS.every((c) => !Number(m[c.key]));

// 把滑块值限制在范围内，忽略未知字段。
export function cleanManual(m = {}) {
  return Object.fromEntries(MANUAL_CONTROLS.map((c) => [c.key, Math.max(c.min, Math.min(c.max, Number(m[c.key]) || 0))]));
}

export function applyManual(channels, fs, manual) {
  if (isNeutral(manual)) return channels;
  const m = cleanManual(manual);
  let ch = channels;
  if (m.pitchSt || m.formantPct) ch = shiftPitchFormant(ch, fs, Math.pow(2, m.pitchSt / 12), 1 + m.formantPct / 100);
  const filters = [
    m.warmDb && design('lowshelf', fs, 200, { gainDb: m.warmDb }),
    m.presenceDb && design('peaking', fs, 3000, { q: 0.8, gainDb: m.presenceDb }),
    m.brightDb && design('highshelf', fs, Math.min(8000, 0.4 * fs), { gainDb: m.brightDb }),
  ].filter(Boolean);
  return ch.map((x) => filters.reduce((y, f) => filter(y, f), x));
}
