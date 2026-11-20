'use strict';
const { BAND, BAND_UP } = require('./effects');
const { overlay } = require('./help');

// The rows that fit above the bottom band. frame() scrolls the lists and pages itself.
const fit = (rows, h) => rows.slice(0, h - 1);

// popup(w, h) is a box to draw over the body, under the band below the header, at most w columns wide and h rows
// tall; or null.
function createScreen({ frame, popup = () => null, effects, output = process.stdout, isPaused = () => false, once = false }) {
  let prev = []; // what each row last showed, so unchanged rows aren't resent
  function draw() {
    if (once || isPaused()) return;
    const w = output.columns || 100, h = output.rows || 50, t = performance.now() / 1000;
    const rows = fit(frame(), h);
    while (rows.length < h - 1) rows.push('');
    const top = rows.indexOf(BAND) + 1, box = popup(w - 1, h - 1 - top); // paint() leaves the last column empty
    if (box) overlay(rows, box, w - 1, top, h - 1);
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
