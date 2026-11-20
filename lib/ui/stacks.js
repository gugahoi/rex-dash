'use strict';
const { dim, green, red, yellow, magenta, plain } = require('../utils');
const { prStatus } = require('../integrations/github');

// A stack's PRs, by status: their tags in rows, their glyphs in a stack's strip, and what each needs, as words.
const TAG = { approved: green('approved'), changes: red('changes'), review: yellow('review'), draft: dim('draft'), merged: magenta('merged'), closed: dim('closed') };
const GLYPH = { approved: green('●'), changes: red('●'), review: yellow('○'), draft: dim('◌'), merged: magenta('✓'), closed: dim('·') };
const NEEDS = { approved: 'approved', changes: 'needs changes', review: 'needs review', draft: 'a draft', merged: 'merged', closed: 'closed' };
const BADGE = '⧉';

// A PR's status, cached before PRs had one or not: from its review decision then.
const statusOf = (p) => p.status ?? prStatus(p);

// Stacks as fetched ({ pages, prs }), with their PRs joined in: from your PRs and review requests (listed) when
// they're there, which are the freshest, else as the stacks were fetched with. A merged or closed PR is so as the
// stack's list says, which knows before the PR lists do. A PR the dashboard has nothing more of shows as its
// branch, and links to its page, which the stack's URL gives.
function joinStacks(d, listed) {
  const known = new Map([...(listed?.mine?.nodes || []), ...(listed?.review?.nodes || [])].map((p) => [`${p.repository?.name}#${p.number}`, p]));
  return (d?.pages || []).flatMap((p) => p.stacks || []).map((s) => {
    const members = s.members.map((m, i) => {
      const pr = known.get(`${s.repo}#${m.number}`) ?? d.prs?.[m.number];
      const status = m.state === 'MERGED' ? 'merged' : m.state === 'CLOSED' ? 'closed' : pr ? statusOf(pr) : m.isDraft ? 'draft' : 'review';
      return {
        ...m, position: i + 1, status, known: !!pr,
        pr: pr ?? { number: m.number, title: m.head, url: String(s.url || '').replace(/\/stack\/\d+$/, `/pull/${m.number}`), repository: { name: s.repo }, isDraft: m.isDraft, commits: { nodes: [] } },
      };
    });
    const updatedAt = members.map((m) => m.pr.updatedAt).filter(Boolean).sort().at(-1);
    return { ...s, key: `${plain(s.repo)}#${s.number}`, members, updatedAt };
  });
}

// A stack at a glance: its counts, out of the whole stack ("2/5 approved", with merged PRs in the 5), a glyph for
// each PR in order, the next to merge (the lowest open PR, which holds up the rest), and whether it's stale: every
// open PR in it a draft.
function summary(s) {
  const n = (st) => s.members.filter((m) => m.status === st).length, size = s.members.length;
  const need = (k, what) => `${k} need${k === 1 ? 's' : ''} ${what}`;
  const open = s.members.filter((m) => m.state === 'OPEN');
  return {
    parts: [
      (n('approved') === size ? green : (x) => x)(`${n('approved')}/${size} approved`),
      n('changes') && red(need(n('changes'), 'changes')),
      n('review') && yellow(need(n('review'), 'review')),
      n('draft') && dim(`${n('draft')} draft${n('draft') === 1 ? '' : 's'}`),
      n('merged') && magenta(`${n('merged')} merged`),
      n('closed') && dim(`${n('closed')} closed`),
    ].filter(Boolean),
    strip: s.members.map((m) => GLYPH[m.status]).join(''),
    next: open[0],
    stale: open.length > 0 && open.every((m) => m.status === 'draft'),
  };
}

module.exports = { TAG, GLYPH, NEEDS, BADGE, statusOf, joinStacks, summary };
