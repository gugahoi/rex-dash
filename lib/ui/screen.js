'use strict';
const { MARK } = require('./sections');
const { BAND_UP } = require('./effects');

function fit(rows, h) {
  const at = rows.findIndex((l) => l.startsWith(MARK));
  rows.splice(3, Math.min(at - 3, at + 2 - (h - 1))); // a negative count removes nothing
  return rows.slice(0, h - 1);
}

function createScreen({ frame, effects, output = process.stdout, isPaused = () => false, once = false }) {
  let prev = []; // what each row last showed, so unchanged rows aren't resent
  function draw() {
    if (once || isPaused()) return;
    const w = output.columns || 100, h = output.rows || 50, t = performance.now() / 1000;
    const rows = fit(frame(), h);
    while (rows.length < h - 1) rows.push('');
    rows.push(BAND_UP);
    let out = '';
    rows.forEach((l, y) => {
      const s = effects.paint(l, y, w, t);
      if (s !== prev[y]) out += `\x1b[${y + 1};1H${s}`;
      prev[y] = s;
    });
    if (out) output.write(out);
  }
  const repaint = () => { prev = []; output.write('\x1b[2J'); draw(); };
  return { draw, repaint };
}
module.exports = { fit, createScreen };
