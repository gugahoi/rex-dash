'use strict';
const { json, sh } = require('../utils');
const { inRepo } = require('../repo');

const RANK = { blocked: 0, error: 1, working: 2, done: 3, idle: 4 };
async function fleet(repo, runJson = json) {
  const { sessions } = await runJson('rex', ['ls', '--json']);
  return Promise.all(sessions.map(async (s) => {
    const { blocks } = await runJson('rex', ['block', 'ls', '-s', s.session_id, '--json']);
    const panes = await Promise.all(blocks.map(async (b) => {
      const call = (m) => runJson('rex', ['block', 'call', '-s', s.session_id, '-b', b.block_id, m]).catch(() => ({}));
      const [proc, status, title] = await Promise.all([call('process'), call('program_status'), call('title')]);
      const rec = (status.records || []).sort((x, y) => (RANK[x.state] ?? 4) - (RANK[y.state] ?? 4))[0];
      return {
        session: s.label, sessionId: s.session_id, windowId: b.window_id, blockId: b.block_id,
        prog: proc.foreground?.name || b.label, cwd: proc.foreground?.cwd, title: title.title, rec,
      };
    }));
    return { label: s.label, panes: panes.filter((p) => inRepo(repo, p.cwd)) };
  })).then((all) => all.filter((s) => s.panes.length));
}

// REX_CLIENT is inherited by both commands so Rex targets the same connected app.
async function focusPane(p, run = sh) {
  await run('rex', ['do', 'session.select', `session_id=${p.sessionId}`, `window_id=${p.windowId}`]);
  await run('rex', ['focus', '-s', p.sessionId, p.blockId]);
}

// Rex starts a command on its server, in its login shell's environment, not ours. So variables go in as
// arguments, which a fixed script exports before it runs command with sh: no value is ever read as shell code.
function withEnv(vars, command) {
  const names = Object.keys(vars);
  if (names.some((n) => !/^[A-Za-z_]\w*$/.test(n))) throw new Error(`bad variable name in ${names.join(' ')}`);
  const script = `export ${names.map((n, i) => `${n}="\${${i + 1}}"`).join(' ')}; exec /bin/sh -c "\${${names.length + 1}}"`;
  return ['/bin/sh', '-c', script, 'rex-dash', ...Object.values(vars).map((v) => String(v ?? '')), command];
}

// Runs argv in a new tab named name, in cwd. The tab goes in the session labelled sessionLabel (the
// worktree's, as wt finds it: by its exact label, created when there's none), or in the session sessionId.
// In the background, the app stays where it is; otherwise it shows the tab. keepOpen keeps the tab after the
// command exits. A failed rex command may still have started argv, so nothing is retried.
async function openTab({ sessionLabel, sessionId, name, cwd, argv, keepOpen = true, background = true }, { runJson = json, run = sh } = {}) {
  const keep = keepOpen ? ['--keep-open'] : [];
  const show = async (sid, wid) => {
    if (!background) await run('rex', ['do', 'session.select', `session_id=${sid}`, ...(wid ? [`window_id=${wid}`] : [])]);
    return { sessionId: sid, windowId: wid };
  };
  if (!sessionId) {
    const { sessions } = await runJson('rex', ['ls', '--json']);
    const ids = sessions.filter((s) => s.label === sessionLabel).map((s) => s.session_id);
    if (ids.length > 1) throw new Error(`several sessions are labelled ${sessionLabel}: ${ids.join(', ')}`);
    if (!ids.length) {
      // A new session isn't shown in the app until it's selected, and its first window runs argv.
      const created = await runJson('rex', ['new', sessionLabel, '-c', cwd, '--window', name, ...keep, '--json', '--', ...argv]);
      if (!created?.session_id) throw new Error(`can't read rex new's response for ${sessionLabel}`);
      return show(created.session_id, created.initial_windows?.[0]?.window_id);
    }
    sessionId = ids[0];
  }
  const created = await runJson('rex', ['window', 'new', '-s', sessionId, name, '-c', cwd, ...keep, '--focus=false', '--json', '--', ...argv]);
  return show(sessionId, created?.window_id);
}
module.exports = { fleet, focusPane, withEnv, openTab };
