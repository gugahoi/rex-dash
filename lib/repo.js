'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sh } = require('./utils');

async function detectRepo(dir) {
  let list;
  try { list = await sh('git', ['-C', dir, 'worktree', 'list', '--porcelain']); } catch { return null; }
  const roots = [];
  for (const entry of list.trim().split('\n\n')) {
    const p = entry.match(/^worktree (.+)$/m)?.[1];
    if (!p) continue;
    const root = /^bare$/m.test(entry) && path.basename(p) === '.bare' ? path.dirname(p) : p;
    try { roots.push(fs.realpathSync(root)); } catch { roots.push(root); } // /tmp is /private/tmp on macOS
  }
  return { roots, gh: null, name: path.basename(roots[0]) };
}
const githubName = (dir) => sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: dir }).then((s) => s.trim(), () => null);
const named = (repo, gh) => Object.assign(repo, { gh, name: gh || path.basename(repo.roots[0]) });
const within = (roots, p) => !!p && roots.some((r) => p === r || p.startsWith(r + '/'));
const inRepo = (repo, p) => !repo || within(repo.roots, p);

module.exports = { detectRepo, githubName, named, within, inRepo };
