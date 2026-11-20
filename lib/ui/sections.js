'use strict';
const { DAYS, dim, bold, red, green, yellow, blue, magenta, cyan, plain, vis, pad, tilde, ago, fmt } = require('../utils');
const { hex, mix, fg, bg, BASE, shaded } = require('./effects');
const { TAG, BADGE, statusOf, summary } = require('./stacks');

const MARK = cyan('▸ ');
// What getSel() returns to mark every row j/k select: the app draws the lists so to find where those rows are.
const EVERY = Symbol('every');
const PR_ROWS = 10; // per list; the filter looks through all that were fetched
const STACK_ROWS = 10, STACK_PRS = 20; // stacks, and PRs in each; the filter looks through them all
const ghKey = (i) => `${plain(i.repository.name)}#${i.number}`;
// What selects a stack's PR: the same PR can show in your PRs too, which ghKey selects.
const memberId = (s, m) => `${s.key}/${ghKey(m.pr)}`;
// How many of your PRs have replies waiting on you.
const awaiting = (mine) => (mine?.nodes || []).filter((p) => p.replies > 0).length;
const head = (title, extra = '') => `\n${bold(shaded(title))}  ${extra}`;
const CI = { SUCCESS: green('✓'), FAILURE: red('✗'), ERROR: red('✗'), PENDING: yellow('◐'), EXPECTED: yellow('◐') };
const REVIEW = { APPROVED: green('approved'), CHANGES_REQUESTED: red('changes'), REVIEW_REQUIRED: yellow('review') };
// The glyph for an issue's linked PRs (the ones that would close it), coloured
// by the best of them: open, then draft, merged, closed.
const LINK = { OPEN: green('⇄'), DRAFT: yellow('⇄'), MERGED: magenta('⇄'), CLOSED: dim('⇄') };
const LINK_RANK = Object.keys(LINK);
const linkState = (p) => (p.state === 'OPEN' && p.isDraft ? 'DRAFT' : p.state);
// A label as a chip in its GitHub colour, lifted when dark so it reads on the dark pane.
function chip({ name, color }) {
  const c = /^[0-9a-f]{6}$/i.test(color) ? hex('#' + color) : [128, 128, 128];
  const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  return `${bg(mix(BASE, c, 0.25))}${fg(mix(c, [255, 255, 255], Math.max(0, 0.6 - lum)))} ${plain(name)} \x1b[0m`;
}
function createSections({ getRepo, getSel, filter }) {
  const { shown, matches } = filter;
  const marked = (key) => { const s = getSel(); return s === key || s === EVERY; };
  const STATE = {
    blocked: yellow('◆ blocked'), error: red('✗ error  '), working: green('● working'),
    done: cyan('✓ done   '), idle: dim('○ idle   '),
  };

  // A pane's rows: a status line and an activity line for a program that reports to Rex, one dim line otherwise.
  function paneLines(p) {
    if (!p.rec) return [dim(`  · ${pad(plain(p.prog), 9)} ${tilde(p.cwd)}`)];
    const r = p.rec;
    const kind = r.state === 'blocked' && r.kind ? yellow(` (${plain(r.kind)})`) : '';
    const [mark, title] = marked(p.blockId) ? [MARK, bold(plain(p.title || r.title))] : ['  ', plain(p.title || r.title)];
    return [
      `${mark}${STATE[r.state] || STATE.idle}${kind} ${dim(pad(ago(r.updated_at), 3))} ${magenta(plain(r.effective_app || p.prog))}  ${title}`,
      dim(`              ${[plain(r.msg), tilde(p.cwd)].filter(Boolean).join(' · ')}`),
    ];
  }
  const paneSession = (p) => plain(p.session); // the filter matches it too

  function renderFleet(f) {
    const panes = f.flatMap((s) => s.panes);
    const n = (st) => panes.filter((p) => p.rec?.state === st).length;
    const groups = f.map((s) => [s.label, shown(s.panes, paneLines, paneSession)]).filter(([, ps]) => ps.length);
    const found = matches(groups.reduce((t, [, ps]) => t + ps.length, 0));
    const out = [head('FLEET', `${f.length} sessions · ${panes.length} panes · ${green(n('working') + ' working')} · ${yellow(n('blocked') + ' blocked')}${found}`)];
    for (const [label, ps] of groups) out.push(bold(plain(label)), ...ps.flatMap((x) => x.lines));
    return out;
  }

  const ci = (p) => CI[p.commits?.nodes[0]?.commit.statusCheckRollup?.state] || dim('·');
  const reply = (p) => (p.replies > 0 ? `${bold(yellow(`↩${p.replies}`))} ` : '');
  // A PR in a stack shows where, such as ⧉2/5: second from the base of a stack of 5.
  const badge = (p) => (p.stack && p.stackEntry ? `${cyan(`${BADGE}${p.stackEntry.position}/${p.stack.size}`)} ` : '');
  const prLine = (p) => {
    const [mark, title] = marked(ghKey(p)) ? [MARK, bold(plain(p.title))] : ['  ', plain(p.title)];
    return `${mark}${ci(p)} ${pad(TAG[statusOf(p)], 8)} ${blue(ghKey(p))} ${badge(p)}${reply(p)}${title} ${dim(ago(p.updatedAt))}`;
  };
  // Your PRs with replies waiting on you go first. The filter finds them with "reply", and a stack's PRs with
  // "stack" and its number.
  const hiddenText = (p) => [p.replies > 0 && 'reply', p.stack && `stack ${plain(p.repository.name)}#${p.stack.number}`].filter(Boolean).join(' ');
  const shownPRs = (list) => shown([...list.nodes].sort((a, b) => (b.replies > 0) - (a.replies > 0)), (p) => [prLine(p)], hiddenText);

  // review and mine say which of the two lists show.
  function renderPRs(d, { review: withReview = true, mine: withMine = true } = {}) {
    const [review, mine] = [d.review, d.mine].map(shownPRs), n = awaiting(d.mine);
    return [
      ...(withReview ? [head('REVIEW REQUESTS', `${d.review.issueCount} waiting on you${matches(review.length)}`), ...review.slice(0, PR_ROWS).flatMap((x) => x.lines)] : []),
      ...(withMine ? [
        head('MY PRS', `${d.mine.issueCount} open${n ? ` · ${yellow(`${n} need${n === 1 ? 's' : ''} your reply`)}` : ''}${matches(mine.length)}`),
        ...mine.slice(0, PR_ROWS).flatMap((x) => x.lines),
      ] : []),
    ];
  }

  // A stack's rows: a heading with its base, a glyph for each PR, its counts and the next to merge, then its PRs in
  // order, from the base up. A stack whose open PRs are all drafts is dim. Merged and closed PRs, and PRs the
  // dashboard has nothing more of than their branch, are dim too.
  function stackLines(s) {
    const { parts, strip, next, stale } = summary(s), sel = marked(s.key);
    const key = sel ? bold(blue(s.key)) : blue(s.key);
    const rest = `${cyan(BADGE)} ${key} ${dim(`→ ${plain(s.base)}`)}  ${strip}  ${parts.join(dim(' · '))}` +
      `${next ? dim(` · next #${next.number}`) : ''}${s.updatedAt ? ` ${dim(ago(s.updatedAt))}` : ''}`;
    const rows = s.members.slice(0, STACK_PRS).map((m) => {
      const p = m.pr, mine = marked(memberId(s, m)), title = plain(p.title);
      const done = !m.known || m.status === 'merged' || m.status === 'closed';
      return `${mine ? MARK : '  '}  ${dim(String(m.position).padStart(2))} ${ci(p)} ${pad(TAG[m.status], 8)} ${blue(ghKey(p))} ${reply(p)}` +
        `${mine ? bold(title) : done ? dim(title) : title}${p.updatedAt ? ` ${dim(ago(p.updatedAt))}` : ''}`;
    });
    const more = s.members.length - STACK_PRS;
    return [`${sel ? MARK : '  '}${stale ? dim(vis(rest)) : rest}`, ...rows, ...(more > 0 ? [dim(`      … ${more} more`)] : [])];
  }
  const shownStacks = (list) => shown(list, stackLines, (s) => `stack ${s.key}`);
  // The repo's open stacks, newest first, as joinStacks() gives them. err says which of their PRs couldn't be fetched.
  function renderStacks(list, err) {
    const ss = shownStacks(list);
    return [
      head('STACKS', `${list.length} open in the repo${err ? ` · ${red(`couldn't fetch their PRs: ${plain(err)}`)}` : ''}${matches(ss.length)}`),
      ...ss.slice(0, STACK_ROWS).flatMap((x) => x.lines),
    ];
  }

  const issueLines = (i) => {
    const links = i.closedByPullRequestsReferences.nodes
      .map((p) => ({ number: p.number, state: linkState(p) }))
      .sort((a, b) => LINK_RANK.indexOf(a.state) - LINK_RANK.indexOf(b.state));
    const who = i.assignees.nodes.map((a) => plain(a.login)).join(', '), n = i.comments.totalCount;
    const meta = [
      `by ${plain(i.author?.login || 'ghost')}`, // a deleted account has no author
      who && `assigned ${who}`,
      n && `${n} comment${n === 1 ? '' : 's'}`,
      i.milestone && `milestone ${plain(i.milestone.title)}`,
      links.length && `pr ${links.map((p) => '#' + p.number).join(' ')}`,
    ].filter(Boolean).join(' · ');
    const [mark, title] = marked(ghKey(i)) ? [MARK, bold(plain(i.title))] : ['  ', plain(i.title)];
    return [
      `${mark}${LINK[links[0]?.state] || dim('·')} ${blue(ghKey(i))} ${title} ${dim(ago(i.updatedAt))}`,
      `    ${[...i.labels.nodes.map(chip), dim(meta)].join(' ')}`,
    ];
  };

  function renderIssues(d) {
    // last: overflow falls off the bottom
    const is = shown(d.nodes, issueLines);
    return [head('ISSUES', `${d.issueCount} ${getRepo() ? 'open' : 'assigned to you'}${matches(is.length)}`), ...is.flatMap((x) => x.lines)];
  }

  const SPARK = ' ▁▂▃▄▅▆▇█';
  function renderUsage(u) {
    const max = Math.max(1, ...u.daily), top = u.models[0]?.[1] || 1;
    if (!u.models.length) return [head(`USAGE · ${DAYS}d tokens`), dim(`  no Claude Code sessions in the last ${DAYS} days`)];
    const out = [head(`USAGE · ${DAYS}d tokens`, shaded(u.daily.map((v) => SPARK[Math.round((v / max) * 8)]).join('')))];
    for (const [model, total, outTok] of u.models.slice(0, 8)) {
      out.push(`  ${pad(plain(model).replace(/^claude-/, ''), 18)} ${pad(fmt(total), 7)} ${dim(pad('out ' + fmt(outTok), 11))} ${shaded('▬'.repeat(Math.max(1, Math.round((total / top) * 20))))}`);
    }
    return out;
  }

  return { paneLines, paneSession, renderFleet, prLine, shownPRs, renderPRs, stackLines, shownStacks, renderStacks, issueLines, renderIssues, renderUsage };
}
module.exports = { createSections, MARK, EVERY, PR_ROWS, STACK_ROWS, STACK_PRS, ghKey, memberId, awaiting, head, CI, REVIEW, LINK, LINK_RANK, linkState, chip };
