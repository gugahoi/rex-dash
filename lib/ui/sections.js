'use strict';
const { DAYS, dim, bold, red, green, yellow, blue, magenta, cyan, plain, pad, tilde, ago, fmt } = require('../utils');
const { hex, mix, fg, bg, BASE, shaded } = require('./effects');

const MARK = cyan('▸ ');
const PR_ROWS = 10; // per list; the filter looks through all that were fetched
const ghKey = (i) => `${plain(i.repository.name)}#${i.number}`;
const head = (title, extra = '') => `\n${bold(shaded(title))}  ${extra}`;
function createSections({ getRepo, getSel, filter }) {
  const { shown, matches } = filter;
  const STATE = {
    blocked: yellow('◆ blocked'), error: red('✗ error  '), working: green('● working'),
    done: cyan('✓ done   '), idle: dim('○ idle   '),
  };

  // A pane's rows: a status line and an activity line for a program that reports to Rex, one dim line otherwise.
  function paneLines(p) {
    if (!p.rec) return [dim(`  · ${pad(plain(p.prog), 9)} ${tilde(p.cwd)}`)];
    const r = p.rec;
    const kind = r.state === 'blocked' && r.kind ? yellow(` (${plain(r.kind)})`) : '';
    const [mark, title] = p.blockId === getSel() ? [MARK, bold(plain(p.title || r.title))] : ['  ', plain(p.title || r.title)];
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

  const CI = { SUCCESS: green('✓'), FAILURE: red('✗'), ERROR: red('✗'), PENDING: yellow('◐'), EXPECTED: yellow('◐') };
  const REVIEW = { APPROVED: green('approved'), CHANGES_REQUESTED: red('changes'), REVIEW_REQUIRED: yellow('review') };
  const prLine = (p) => {
    const ci = CI[p.commits.nodes[0]?.commit.statusCheckRollup?.state] || dim('·');
    const tag = p.isDraft ? dim('draft') : REVIEW[p.reviewDecision] || dim('open');
    const [mark, title] = ghKey(p) === getSel() ? [MARK, bold(plain(p.title))] : ['  ', plain(p.title)];
    return `${mark}${ci} ${pad(tag, 8)} ${blue(ghKey(p))} ${title} ${dim(ago(p.updatedAt))}`;
  };
  const shownPRs = (list) => shown(list.nodes, (p) => [prLine(p)]);

  function renderPRs(d) {
    const [review, mine] = [d.review, d.mine].map(shownPRs);
    return [
      head('REVIEW REQUESTS', `${d.review.issueCount} waiting on you${matches(review.length)}`), ...review.slice(0, PR_ROWS).flatMap((x) => x.lines),
      head('MY PRS', `${d.mine.issueCount} open${matches(mine.length)}`), ...mine.slice(0, PR_ROWS).flatMap((x) => x.lines),
    ];
  }

  // The glyph for an issue's linked PRs (the ones that would close it), coloured
  // by the best of them: open, then draft, merged, closed.
  const LINK = { OPEN: green('⇄'), DRAFT: yellow('⇄'), MERGED: magenta('⇄'), CLOSED: dim('⇄') };
  const LINK_RANK = Object.keys(LINK);
  // A label as a chip in its GitHub colour, lifted when dark so it reads on the dark pane.
  function chip({ name, color }) {
    const c = /^[0-9a-f]{6}$/i.test(color) ? hex('#' + color) : [128, 128, 128];
    const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    return `${bg(mix(BASE, c, 0.25))}${fg(mix(c, [255, 255, 255], Math.max(0, 0.6 - lum)))} ${plain(name)} \x1b[0m`;
  }
  const issueLines = (i) => {
    const links = i.closedByPullRequestsReferences.nodes
      .map((p) => ({ number: p.number, state: p.state === 'OPEN' && p.isDraft ? 'DRAFT' : p.state }))
      .sort((a, b) => LINK_RANK.indexOf(a.state) - LINK_RANK.indexOf(b.state));
    const who = i.assignees.nodes.map((a) => plain(a.login)).join(', '), n = i.comments.totalCount;
    const meta = [
      `by ${plain(i.author?.login || 'ghost')}`, // a deleted account has no author
      who && `assigned ${who}`,
      n && `${n} comment${n === 1 ? '' : 's'}`,
      i.milestone && `milestone ${plain(i.milestone.title)}`,
      links.length && `pr ${links.map((p) => '#' + p.number).join(' ')}`,
    ].filter(Boolean).join(' · ');
    const [mark, title] = ghKey(i) === getSel() ? [MARK, bold(plain(i.title))] : ['  ', plain(i.title)];
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

  return { paneLines, paneSession, renderFleet, prLine, shownPRs, renderPRs, issueLines, renderIssues, renderUsage };
}
module.exports = { createSections, MARK, PR_ROWS, ghKey, head };
