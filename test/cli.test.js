'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Exercise the actual CLI with only Rex and GitHub stubbed. No live app, auth,
// network, or Claude Code installation is required.
test('--once fetches data, keeps the Rex command protocol, writes caches, and runs through a symlink', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-dash-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), projects = path.join(dir, '.claude', 'projects', 'p');
  fs.mkdirSync(bin); fs.mkdirSync(projects, { recursive: true });
  const executable = (name, body) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, '#!/bin/sh\n' + body);
    fs.chmodSync(file, 0o755);
  };
  executable('rex', `echo "$*" >> "$CALL_LOG"
case "$*" in
  'ls --json') echo '{"sessions":[{"session_id":"s","label":"web"}]}' ;;
  'block ls -s s --json') echo '{"blocks":[{"block_id":"b","window_id":"w","label":"pi"}]}' ;;
  'block call -s s -b b process') echo '{"foreground":{"name":"pi","cwd":"${dir}"}}' ;;
  'block call -s s -b b program_status') echo '{"records":[{"state":"working","title":"coding","updated_at":"2026-11-01T01:00:00Z"}]}' ;;
  'block call -s s -b b title') echo '{"title":"coding"}' ;;
esac
`);
  executable('gh', `case "$1" in
  api)
    case "$*" in
      *is:pr*) echo '{"data":{"mine":{"issueCount":0,"nodes":[]},"review":{"issueCount":0,"nodes":[]}}}' ;;
      *) echo '{"data":{"issues":{"issueCount":0,"nodes":[]}}}' ;;
    esac ;;
esac
`);
  fs.writeFileSync(path.join(projects, 's.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), cwd: dir, message: { id: 'm', model: 'claude-x', usage: { output_tokens: 4 } } }));
  const link = path.join(bin, 'rex-dash');
  fs.symlinkSync(path.join(__dirname, '..', 'rex-dash'), link);
  const log = path.join(dir, 'calls');
  const env = { ...process.env, HOME: dir, XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_STATE_HOME: path.join(dir, 'state'), CALL_LOG: log, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  assert.equal(execFileSync(link, ['--test'], { cwd: dir, env, encoding: 'utf8' }).trim(), 'ok');
  const output = execFileSync(link, ['--once'], { cwd: dir, env, encoding: 'utf8' });
  for (const word of ['FLEET', 'web', 'coding', 'USAGE', '4', 'REVIEW REQUESTS', 'MY PRS', 'ISSUES']) assert.ok(output.includes(word), word);
  assert.ok(!output.includes('[j/k]'));
  const calls = fs.readFileSync(log, 'utf8');
  for (const cmd of ['ls --json', 'block ls -s s --json', 'block call -s s -b b process', 'block call -s s -b b program_status', 'block call -s s -b b title']) assert.ok(calls.includes(cmd), cmd);
  const cache = path.join(dir, 'cache', 'rex-dash', 'all');
  assert.equal(JSON.parse(fs.readFileSync(path.join(cache, 'state.json'))).version, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cache, 'transcripts.json'))).version, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'state', 'rex-dash', 'settings.json')));
});

test('repo-mode --once scopes GitHub and cache to the detected worktree', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-dash-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), bin = path.join(dir, 'bin'), home = path.join(dir, 'home');
  fs.mkdirSync(repo); fs.mkdirSync(bin); fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const stub = (name, body) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, '#!/bin/sh\n' + body);
    fs.chmodSync(file, 0o755);
  };
  stub('rex', `echo '{"sessions":[]}'`);
  stub('gh', `case "$1" in
  repo) echo 'owner/repo' ;;
  api)
    echo "$*" >> "$QUERY_LOG"
    case "$*" in
      *is:pr*) echo '{"data":{"mine":{"issueCount":0,"nodes":[]},"review":{"issueCount":0,"nodes":[]}}}' ;;
      *) echo '{"data":{"issues":{"issueCount":0,"nodes":[]}}}' ;;
    esac ;;
esac
`);
  const log = path.join(dir, 'queries');
  const env = { ...process.env, HOME: home, XDG_CACHE_HOME: path.join(dir, 'cache'), QUERY_LOG: log, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const output = execFileSync(process.execPath, [path.join(__dirname, '..', 'rex-dash'), '--once'], { cwd: repo, env, encoding: 'utf8' });
  assert.ok(output.includes('owner/repo'));
  assert.equal(fs.readFileSync(log, 'utf8').match(/repo:owner\/repo/g).length, 3); // both PR searches and the issues search
  const caches = fs.readdirSync(path.join(dir, 'cache', 'rex-dash'));
  assert.equal(caches.length, 1);
  assert.match(caches[0], /^repo-[0-9a-f]{8}$/);
  assert.ok(fs.existsSync(path.join(dir, 'cache', 'rex-dash', caches[0], 'state.json')));
});
