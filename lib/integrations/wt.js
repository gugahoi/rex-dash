'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dim } = require('../utils');

// wt needs the terminal for prompts and setup. Do not draw or read dashboard keys
// while it owns the pane. Always restore raw mode and the alternate screen. env, when given, is wt's whole
// environment.
async function runWorktree(kind, number, { stdin = process.stdin, stdout = process.stdout, spawnCommand = spawn, onHandoff = () => {}, env } = {}) {
  onHandoff(true);
  let end;
  try {
    stdin.setRawMode(false).pause();
    stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
    end = await new Promise((resolve, reject) => {
      let child;
      try { child = spawnCommand('wt', [kind, String(number)], env ? { stdio: 'inherit', env } : { stdio: 'inherit' }); } catch (error) { reject(error); return; }
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

// With WT_MULTIPLEXER=command, wt makes the worktree as usual (its prompts, then wt.setupCommand) and then,
// rather than open it, runs WT_OPEN_COMMAND with the worktree in WT_WORKTREE, WT_BRANCH and WT_SESSION (the
// label of the Rex session it would open). This one is ours and constant: it writes them to files in
// REX_DASH_HANDOFF, so that no path or branch name is ever in a command's text.
const HANDOFF = ['WT_WORKTREE', 'WT_BRANCH', 'WT_SESSION'].map((v) => `printf %s "$${v}" > "$REX_DASH_HANDOFF/${v}"`).join(' && ');

// The issue's or PR's worktree, made by wt in the terminal like runWorktree: { end, worktree }, where
// worktree is { path, branch, session }, or null when wt didn't get as far as opening one: it failed, or the
// branch prompt was cancelled.
async function prepareWorktree(kind, number, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-dash-'));
  try {
    const env = { ...process.env, WT_MULTIPLEXER: 'command', WT_OPEN_COMMAND: HANDOFF, REX_DASH_HANDOFF: dir };
    const end = await runWorktree(kind, number, { ...opts, env });
    const read = (v) => { try { return fs.readFileSync(path.join(dir, v), 'utf8'); } catch { return ''; } };
    const worktree = !end.error && end.code === 0 && read('WT_WORKTREE')
      ? { path: read('WT_WORKTREE'), branch: read('WT_BRANCH'), session: read('WT_SESSION') } : null;
    return { end, worktree };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
module.exports = { runWorktree, prepareWorktree, HANDOFF };
