'use strict';
const { spawn } = require('node:child_process');
const { dim } = require('../utils');

// wt needs the terminal for prompts and setup. Do not draw or read dashboard keys
// while it owns the pane. Always restore raw mode and the alternate screen.
async function runWorktree(kind, number, { stdin = process.stdin, stdout = process.stdout, spawnCommand = spawn, onHandoff = () => {} } = {}) {
  onHandoff(true);
  let end;
  try {
    stdin.setRawMode(false).pause();
    stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
    end = await new Promise((resolve, reject) => {
      let child;
      try { child = spawnCommand('wt', [kind, String(number)], { stdio: 'inherit' }); } catch (error) { reject(error); return; }
      child.once('error', (error) => resolve({ error })).once('exit', (code, signal) => resolve({ code, signal }));
    });
    stdin.setRawMode(true).resume();
    if (!end.error && end.code !== 0) {
      stdout.write(`\n${dim(`wt ${end.signal ? `killed by ${end.signal}` : `exited with ${end.code}`} · press a key`)}`);
      await new Promise((resolve) => stdin.once('data', resolve));
    }
  } finally {
    stdin.setRawMode(true).resume();
    stdout.write('\x1b[?1049h\x1b[?25l');
    onHandoff(false);
  }
  return end;
}
module.exports = { runWorktree };
