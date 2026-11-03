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
module.exports = { fleet, focusPane };
