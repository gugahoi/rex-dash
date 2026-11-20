'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'try-pr.sh');
const PLATFORM = `${process.platform}-${process.arch}`;
const SHA = 'abcdef1234567890abcdef1234567890abcdef12', NEXT = '1234567abcdef1234567abcdef1234567abcdef1';
const hasJq = spawnSync('jq', ['--version']).status === 0;

// gh is stubbed: its --jq runs on fixtures through jq, as gh's own does. Artifacts are folders of files.
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-dash-try-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), artifacts = path.join(dir, 'artifacts'), caller = path.join(dir, 'caller');
  for (const d of [bin, artifacts, caller]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
echo "gh $*" >> "$CALL_LOG"
flag() { want="$1"; shift; prev=''; for a in "$@"; do [ "$prev" = "$want" ] && echo "$a"; prev="$a"; done; }
case "$1 $2" in
  'pr view') printf '%s' "$PR_JSON" | jq -r "$(flag --jq "$@")" ;;
  'run list') printf '%s' "$RUNS_JSON" | jq -r "$(flag --jq "$@")" ;;
  'run download')
    name="$(flag --name "$@")" dir="$(flag --dir "$@")"
    [ -d "$ARTIFACTS/$name" ] || { echo 'no valid artifacts found to download' >&2; exit 1; }
    mkdir -p "$dir" && cp "$ARTIFACTS/$name"/* "$dir" ;;
  'pr diff') printf '%s\\n' "$DIFF_FILES" ;;
  *) echo "unexpected: gh $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  // A stand-in binary that reports how it was started.
  const stage = path.join(dir, 'stage');
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, 'rex-dash'), `#!/bin/sh
[ "$1" = --test ] && { echo ok; exit; }
echo "cwd=$PWD"; echo "args=$*"; echo "cache=$XDG_CACHE_HOME"; echo "state=$XDG_STATE_HOME"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(stage, 'LICENSE'), 'MIT');
  const artifact = path.join(artifacts, `rex-dash-${PLATFORM}`), archive = `rex-dash-v0.0.0-${PLATFORM}.tar.gz`;
  fs.mkdirSync(artifact);
  execFileSync('tar', ['-czf', path.join(artifact, archive), '-C', stage, 'rex-dash', 'LICENSE']);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(artifact, archive))).digest('hex');
  fs.writeFileSync(path.join(artifact, `${archive}.sha256`), `${hash}  ${archive}\n`);

  const log = path.join(dir, 'calls'), cache = path.join(dir, 'cache');
  const env = {
    ...process.env, HOME: dir, XDG_CACHE_HOME: cache, XDG_STATE_HOME: path.join(dir, 'state'), PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    CALL_LOG: log, ARTIFACTS: artifacts, DIFF_FILES: 'lib/app.js',
    PR_JSON: JSON.stringify({ number: 13, headRefOid: SHA }),
    RUNS_JSON: JSON.stringify([{ databaseId: 7, status: 'completed', conclusion: 'success', url: 'https://ci/7' }]),
  };
  const run = (args, extra = {}) => {
    fs.writeFileSync(log, '');
    const r = spawnSync('bash', [SCRIPT, ...args], { cwd: caller, env: { ...env, ...extra }, encoding: 'utf8' });
    return { ...r, calls: fs.readFileSync(log, 'utf8') };
  };
  return { run, caller, env, artifact, builds: path.join(cache, 'rex-dash-builds', 'pr-13') };
}

test('downloads, checks and keeps a PR\'s binary, reuses it, and runs it shared or isolated', { skip: !hasJq && 'needs jq' }, (t) => {
  const { run, caller, env, builds } = setup(t);
  const first = run(['13']);
  assert.equal(first.status, 0, first.stderr);
  const binary = path.join(builds, 'abcdef1', 'rex-dash');
  assert.ok(fs.existsSync(binary) && fs.existsSync(path.join(builds, 'abcdef1', 'LICENSE')));
  assert.ok(first.stdout.includes('Downloaded PR #13\'s build of abcdef1'));
  assert.ok(first.stdout.includes(binary) && first.stdout.includes('rex split'));
  assert.ok(first.calls.includes(`gh run list --workflow ci.yml --commit ${SHA} --event pull_request`));
  assert.ok(first.calls.includes(`gh run download 7 --name rex-dash-${PLATFORM}`));

  // Downloaded once, until the PR gets a new commit. It runs in the caller's folder, with its arguments.
  const shared = run(['13', '--run', '--', '--once', 'a b']);
  assert.equal(shared.status, 0, shared.stderr);
  assert.ok(!shared.calls.includes('run download'));
  for (const line of [`cwd=${fs.realpathSync(caller)}`, 'args=--once a b', `cache=${env.XDG_CACHE_HOME}`, `state=${env.XDG_STATE_HOME}`]) {
    assert.ok(shared.stdout.split('\n').includes(line), line);
  }

  const isolated = run(['--isolated', '--run']);
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.ok(isolated.calls.includes('gh pr view --json')); // no PR: the PR for the checkout's branch
  for (const line of [`cache=${path.join(builds, 'cache')}`, `state=${path.join(builds, 'state')}`]) {
    assert.ok(isolated.stdout.split('\n').includes(line), line);
  }
  assert.ok(!isolated.calls.includes('pr diff'));

  // A new commit replaces the PR's build, but not its isolated cache and settings.
  fs.mkdirSync(path.join(builds, 'cache'), { recursive: true });
  const next = run(['13'], { PR_JSON: JSON.stringify({ number: 13, headRefOid: NEXT }) });
  assert.equal(next.status, 0, next.stderr);
  assert.deepEqual(fs.readdirSync(builds).sort(), ['1234567', 'cache']);
});

test('suggests --isolated when the PR changes what rex-dash saves', { skip: !hasJq && 'needs jq' }, (t) => {
  const { run } = setup(t);
  assert.ok(!run(['13']).stderr.includes('--isolated'));
  for (const file of ['lib/storage.js', 'lib/usage.js']) {
    const r = run(['13'], { DIFF_FILES: `README.md\n${file}` });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('Consider --isolated'), file);
  }
});

test('says why there\'s no binary, and keeps none that fails its checksum', { skip: !hasJq && 'needs jq' }, (t) => {
  const { run, artifact, builds } = setup(t);
  const runs = (status, conclusion) => JSON.stringify([{ databaseId: 7, status, conclusion, url: 'https://ci/7' }]);
  const none = run(['13'], { RUNS_JSON: '[]' });
  assert.equal(none.status, 1);
  assert.ok(none.stderr.includes('CI hasn\'t run on PR #13\'s last commit, abcdef1, yet.'));

  // A platform's binary can be downloaded as soon as it's built, before the whole run ends.
  const early = run(['13'], { RUNS_JSON: runs('in_progress', '') });
  assert.equal(early.status, 0, early.stderr);
  assert.ok(early.stderr.includes('CI is still running for abcdef1'));
  const failed = run(['13', '--run'], { RUNS_JSON: runs('completed', 'failure'), PR_JSON: JSON.stringify({ number: 13, headRefOid: NEXT }) });
  assert.equal(failed.status, 0, failed.stderr);
  assert.ok(failed.stderr.includes('CI ended in failure for 1234567'));

  fs.rmSync(builds, { recursive: true });
  const sums = fs.readdirSync(artifact).find((f) => f.endsWith('.sha256'));
  fs.writeFileSync(path.join(artifact, sums), `${'0'.repeat(64)}  ${sums.replace(/\.sha256$/, '')}\n`);
  const bad = run(['13']);
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.includes('doesn\'t match its SHA-256 file'));
  assert.ok(!fs.existsSync(builds));

  fs.rmSync(artifact, { recursive: true });
  const waiting = run(['13'], { RUNS_JSON: runs('in_progress', '') });
  assert.equal(waiting.status, 1);
  assert.ok(waiting.stderr.includes('isn\'t built yet. To wait for it: gh run watch 7'));
  const gone = run(['13'], { RUNS_JSON: runs('completed', 'success') });
  assert.equal(gone.status, 1);
  assert.ok(gone.stderr.includes('its build failed, or it expired after 14 days. See https://ci/7'));
});

test('rejects unknown options, and arguments without --run', () => {
  for (const args of [['--nope'], ['13', '14'], ['13', '--', '--once']]) {
    assert.equal(spawnSync('bash', [SCRIPT, ...args]).status, 64, args.join(' '));
  }
});
