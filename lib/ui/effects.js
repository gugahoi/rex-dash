'use strict';
const { vis, clip, dim } = require('../utils');
const { readJSON, writeJSON, SETTINGS } = require('../storage');

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const ramp = (stops, k) => {
  k = Math.min(1, Math.max(0, k)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, k | 0);
  return mix(stops[i], stops[i + 1], k - i);
};
const AURORA = ['#0f9b8e', '#14f195', '#00d4ff', '#9945ff'].map(hex);
const EMBER = ['#ff2e63', '#ff7a3c', '#ffd23f'].map(hex);
const RAINBOW = ['#ff5f6d', '#ffc371', '#47e891', '#3ab0ff', '#c86dd7', '#ff5f6d'].map(hex); // ends where it starts, so it cycles
// Each shader maps a cell (x, y) at time t seconds to a colour.
const SHADERS = {
  aurora: (x, y, t) => ramp(AURORA, (Math.sin(x * 0.11 + t * 0.9) + 0.5 * Math.sin(x * 0.23 - t * 1.4 + y * 0.5) + 1.5) / 3),
  plasma: (x, y, t) => ramp(RAINBOW, ((Math.sin(x * 0.15 + t) + Math.sin(x * 0.07 + y * 0.6 - t * 1.6) + Math.sin(Math.hypot(x - 40, y * 2 - 20) * 0.12 - t * 1.2)) / 6 + 0.5 + t * 0.05) % 1),
  ember: (x, y, t) => ramp(EMBER, (Math.sin(x * 0.13 - t * 1.1) * Math.cos(x * 0.05 + t * 0.7 + y * 0.3) + 1) / 2),
  off: null,
};
const EFFECTS = ['bloom+scanlines', 'bloom', 'scanlines', 'off'];
// Glows are mixed over BASE, the background scanlines paint. Without
// scanlines the terminal's own background shows, so keep BASE close to a dark theme.
const BASE = hex('#0d1117'), SCANLINE = hex('#07090d');
const NEON = { 31: hex('#ff5c57'), 32: hex('#5af78e'), 33: hex('#f3f99d'), 34: hex('#82aaff'), 35: hex('#ff6ac1'), 36: hex('#9aedfe') };
const fg = ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`;
const bg = ([r, g, b]) => `\x1b[48;2;${r};${g};${b}m`;
const BAND = '\x03', BAND_UP = '\x04'; // rows paint() draws as shader bands, glowing down or up
const shaded = (s) => `\x01${s}\x02`; // text paint() colours with the shader
const cycle = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];

function createEffects({ once = false, settingsFile = SETTINGS } = {}) {
  const fx = { shader: once ? 'off' : 'aurora', effect: once ? 'off' : 'bloom+scanlines' };
  function loadFx(file = settingsFile) {
    const s = readJSON(file);
    if (Object.keys(SHADERS).includes(s?.shader)) fx.shader = s.shader;
    if (EFFECTS.includes(s?.effect)) fx.effect = s.effect;
  }
  const saveFx = (file = settingsFile) => writeJSON(file, { shader: fx.shader, effect: fx.effect });

  function paint(line, y, w, t) {
    const shader = SHADERS[fx.shader], bloom = fx.effect.includes('bloom'), scan = fx.effect.includes('scanlines');
    const rowBg = scan ? bg(y % 2 ? SCANLINE : BASE) : '';
    const glow = (c, k = 0.12) => (bloom ? bg(mix(BASE, c, k)) : ''); // stronger reads as label chips, not a glow
    if (line === BAND || line === BAND_UP) {
      if (!shader) return rowBg + dim('─'.repeat(w - 1)) + rowBg + '\x1b[K';
      let s = '';
      for (let x = 0; x < w; x++) {
        const c = shader(x, y, t);
        s += bloom ? fg(c) + glow(c, 0.35) + (line === BAND ? '▀' : '▄') : fg(c) + rowBg + '━';
      }
      return s + '\x1b[0m';
    }
    let s = line.replace(/\x01([^\x02]*)\x02/g, (_, text, at, whole) => {
      if (!shader) return `\x1b[36m${text}\x1b[39;49m`;
      const x0 = vis(whole.slice(0, at)).length;
      return [...text].map((ch, i) => { const c = shader(x0 + i, y, t); return fg(c) + glow(c) + ch; }).join('') + '\x1b[39;49m';
    });
    if (bloom) s = s.replace(/\x1b\[(3[1-6])m/g, (_, n) => fg(NEON[n]) + glow(NEON[n]));
    if (scan) s = rowBg + s.replace(/\x1b\[(?:0|49|39;49)?m/g, (m) => m + rowBg); // resets drop the row colour; put it back
    // w - 1: erasing to end of line from the last column would wipe its character
    return clip(s, w - 1) + rowBg + '\x1b[K';
  }

  return { fx, loadFx, saveFx, paint };
}
module.exports = { createEffects, SHADERS, EFFECTS, BAND, BAND_UP, BASE, SCANLINE, hex, mix, fg, bg, shaded, cycle };
