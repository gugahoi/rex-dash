'use strict';
const { dim, bold, red, green, yellow, blue, magenta, cyan, plain, vis, pad, ago } = require('../utils');
const { head, MARK, CI, REVIEW, LINK, LINK_RANK, linkState, chip } = require('./sections');
const { TAG, GLYPH, NEEDS, BADGE, summary } = require('./stacks');

// The columns a character takes: two for emoji and East Asian wide characters, none for combining marks, joiners
// and variation selectors. Wrapping by them keeps a line from spilling into the next row.
const WIDE = /\p{Emoji_Presentation}|[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
const ZERO = /[\p{Mn}\p{Me}\u200b-\u200f\ufe00-\ufe0f]/u;
const charCols = (ch) => (ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1);
const cols = (s) => { let n = 0; for (const ch of s) n += charCols(ch); return n; };

// A line of plain text as lines of at most w columns, broken at spaces, or inside a word too long for a line.
// Lines after the first hang under a list item's or a quote's text.
function wrap(line, w) {
  w = Math.max(10, w);
  if (cols(line) <= w) return [line];
  const hang = ' '.repeat(Math.min(cols(line.match(/^\s*(?:(?:[-*+>]|\d+[.)])\s+)?/)[0]), w >> 1));
  const out = [];
  let cur = '', n = 0;
  const flush = () => { out.push(cur.trimEnd()); cur = hang; n = hang.length; };
  for (const word of line.match(/\s*\S+/g) || []) {
    const k = cols(word);
    if (n + k <= w) { cur += word; n += k; continue; }
    if (cur.trim()) flush();
    for (const ch of word.trimStart()) {
      const c = charCols(ch);
      if (n + c > w && cur.trim()) flush();
      cur += ch; n += c;
    }
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out;
}

// A line of plain text cut to w columns, with … where it was cut.
function cut(line, w) {
  if (cols(line) <= w) return line;
  let out = '', n = 0;
  for (const ch of line) {
    if (n + charCols(ch) > w - 1) break;
    out += ch; n += charCols(ch);
  }
  return out + '…';
}

// Styled parts as lines of at most w columns, indent first, with sep between the parts on a line.
function flow(parts, w, indent = '  ', sep = dim(' · ')) {
  const out = [], room = w - cols(indent), gap = cols(vis(sep));
  let cur = '', n = 0;
  for (const p of parts.filter(Boolean)) {
    const k = cols(vis(p));
    if (cur && n + gap + k > room) { out.push(indent + cur); cur = ''; n = 0; }
    if (cur) { cur += sep; n += gap; }
    cur += p; n += k;
  }
  if (cur) out.push(indent + cur);
  return out;
}

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'" };
const TAGS = /<\/?(?:a|b|blockquote|code|dd|details|div|dl|dt|em|g-emoji|h[1-6]|i|kbd|li|ol|p|picture|pre|source|span|strong|sub|summary|sup|table|tbody|td|th|thead|tr|ul)\b[^>]*>/gi;
// Markdown from GitHub, outside code blocks, as plain lines: without HTML comments or the usual HTML tags, with
// images as [image] and the usual entities decoded.
const tidy = (text) => text.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => `[image${alt.trim() ? `: ${alt.trim()}` : ''}]`)
  .replace(/<img\b[^>]*>/gi, '[image]').replace(/<br\s*\/?>/gi, '\n').replace(/<hr\s*\/?>/gi, '\n---\n')
  .replace(TAGS, '').replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (_, e) => ENTITY[e]).split('\n');

// Markdown from GitHub as styled lines that fit w columns, each starting with indent: headings bold, quotes and
// code blocks dim, the rest as written, and no control character from it gets through. Blank lines between
// paragraphs collapse to one. After max lines, it says how many more there are.
function prose(body, w, indent = '  ', max = Infinity) {
  const room = w - cols(indent), out = [];
  const add = (line, style = (s) => s) => out.push(...wrap(line, room).map((l) => indent + style(l)));
  let fence = null, text = [];
  const flushText = () => {
    for (const raw of tidy(text.join('\n'))) {
      const line = plain(raw.replace(/\t/g, '    ')).trimEnd();
      if (!line.trim()) { if (out.length && out.at(-1) !== '') out.push(''); continue; }
      const heading = line.match(/^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?$/);
      if (heading) add(heading[1], bold);
      else if (/^ {0,3}([-*_])(?:\s*\1){2,}$/.test(line)) out.push(indent + dim('─'.repeat(Math.min(room, 40))));
      else add(line, /^\s*>/.test(line) ? dim : undefined);
    }
    text = [];
  };
  for (const raw of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const mark = raw.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (!fence && mark) { flushText(); fence = mark; }
    else if (!fence) { text.push(raw); continue; }
    else if (mark && mark[0] === fence[0] && mark.length >= fence.length && !raw.trim().slice(mark.length)) fence = null;
    add(plain(raw.replace(/\t/g, '    ')).trimEnd(), dim); // code, and its fences, as written
  }
  flushText();
  while (out.at(-1) === '') out.pop();
  if (out.length <= max) return out;
  const more = out.length - max;
  return [...out.slice(0, max), dim(`${indent}… ${more} more line${more === 1 ? '' : 's'}: [o] opens it in the browser`)];
}

const nodes = (c) => c?.nodes || [];
const at = (t) => Date.parse(t) || 0;
const some = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const title = (t, w) => wrap(plain(t), w - 2).map((l) => '  ' + bold(l));
const WAIT = yellow('↩ ');
// Groups of lines, with a blank line between them.
const apart = (groups) => groups.flatMap((g, i) => (i ? ['', ...g] : g));
// Who wrote something, and when. A deleted account has no author.
const by = (author, verb, when) =>
  `${bold(plain(author?.login || 'ghost'))}${author?.__typename === 'Bot' ? dim(' (bot)') : ''}${verb ? ` ${verb}` : ''} ${dim(`· ${ago(when)}`)}`;

const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const SKIPPED = ['SKIPPED', 'NEUTRAL', 'STALE'];
// A PR's checks: the failing ones by name, then how many are pending, passed and skipped.
function checks(rollup) {
  const runs = nodes(rollup?.contexts).map((c) => (c.__typename === 'StatusContext'
    ? { name: c.context, is: c.state === 'SUCCESS' ? 'pass' : ['PENDING', 'EXPECTED'].includes(c.state) ? 'wait' : 'fail' }
    : { name: c.name, is: c.status !== 'COMPLETED' ? 'wait' : FAILED.includes(c.conclusion) ? 'fail' : SKIPPED.includes(c.conclusion) ? 'skip' : 'pass' }));
  if (!runs.length) return [];
  const n = (is) => runs.filter((r) => r.is === is).length;
  return [
    dim('checks'), ...runs.filter((r) => r.is === 'fail').map((r) => red(`✗ ${plain(r.name)}`)),
    n('wait') && yellow(`◐ ${n('wait')} pending`), n('pass') && green(`✓ ${n('pass')} passed`), n('skip') && dim(`${n('skip')} skipped`),
  ];
}

const DIFF = { '+': green, '-': red };
const VERB = { APPROVED: green('approved'), CHANGES_REQUESTED: red('requested changes'), COMMENTED: dim('reviewed'), DISMISSED: dim('reviewed, since dismissed') };

// A PR's page: its state, its unresolved review threads, the ones waiting on you first, its description, then its
// conversation. As in the list, a thread waits on you when someone else, not a bot, has the last word: in your PR,
// or in a thread you wrote in. A comment or review waits on you in your PR when it came after your last comment,
// review or commit.
function prPage(d, key, w, stack) {
  const me = d.viewer, mine = !!me && d.author?.login === me;
  const yours = (a) => !!me && a?.login === me, theirs = (a) => !!me && !yours(a) && a?.__typename !== 'Bot';
  const commit = nodes(d.commits)[0]?.commit;
  const waits = (t) => { const cs = nodes(t.comments); return cs.length > 0 && theirs(cs.at(-1).author) && (mine || cs.some((c) => yours(c.author))); };
  const all = nodes(d.reviewThreads), open = all.filter((t) => !t.isResolved), waiting = open.filter(waits).length;
  const total = d.reviewThreads?.totalCount ?? all.length;

  const thread = (t) => {
    const cs = nodes(t.comments), line = t.line ?? t.originalLine, start = t.startLine ?? t.originalStartLine;
    const where = plain(t.path) + (t.subjectType === 'FILE' || !line ? '' : `:${start && start !== line ? `${start}-` : ''}${line}`);
    const span = t.originalLine && t.originalStartLine ? t.originalLine - t.originalStartLine + 1 : 1;
    const hunk = (nodes(t.hunk)[0]?.diffHunk || '').split('\n').filter((l) => l && !l.startsWith('@@')).slice(-Math.min(6, Math.max(3, span)));
    const more = (t.comments?.totalCount ?? cs.length) - cs.length;
    return [
      `  ${waits(t) ? WAIT : ''}${cyan(where)}${t.isOutdated ? dim(' · outdated') : ''}`,
      ...hunk.map((l) => '    ' + (DIFF[l[0]] || dim)(cut(plain(l.replace(/\t/g, '    ')), w - 4))),
      ...cs.flatMap((c) => [`    ${by(c.author, '', c.createdAt)}`, ...prose(c.body, w, '      ', 40)]),
      ...(more > 0 ? [dim(`    … ${some(more, 'more comment')}: [o] opens it in the browser`)] : []),
    ];
  };

  const last = Math.max(at(commit?.committedDate), ...nodes(d.comments).filter((c) => yours(c.author)).map((c) => at(c.createdAt)),
    ...nodes(d.reviews).filter((r) => yours(r.author)).map((r) => at(r.submittedAt)));
  const talk = [
    ...nodes(d.comments).map((c) => ({ author: c.author, when: c.createdAt, verb: dim('commented'), body: c.body, asks: true })),
    ...nodes(d.reviews).filter((r) => VERB[r.state] && (r.state !== 'COMMENTED' || r.body?.trim())).map((r) =>
      ({ author: r.author, when: r.submittedAt, verb: VERB[r.state], body: r.body, asks: ['COMMENTED', 'CHANGES_REQUESTED'].includes(r.state) })),
  ].sort((a, b) => at(a.when) - at(b.when));
  const shown = nodes(d.comments).length, comments = d.comments?.totalCount ?? shown;

  const state = d.state === 'OPEN' ? (d.isDraft ? dim('draft') : green('open')) : d.state === 'MERGED' ? magenta('merged') : red('closed');
  return [
    head(`PR ${key}`),
    ...title(d.title, w),
    ...flow([
      state, d.state === 'OPEN' && REVIEW[d.reviewDecision], dim(`by ${plain(d.author?.login || 'ghost')}`),
      dim(`${plain(d.headRefName)} → ${plain(d.baseRefName)}`),
      `${green(`+${d.additions ?? 0}`)} ${red(`−${d.deletions ?? 0}`)} ${dim(`in ${some(d.changedFiles ?? 0, 'file')}`)}`,
      dim(`opened ${ago(d.createdAt)} ago`), dim(`updated ${ago(d.updatedAt)} ago`),
    ], w),
    ...flow(checks(commit?.statusCheckRollup), w),
    dim(`  ${plain(d.url)}`),
    ...stackBlock(d, stack, w),
    head('UNRESOLVED THREADS', dim(`${open.length} of ${total}${total > all.length ? `, in the first ${all.length}` : ''}`) +
      (waiting ? `${dim(' · ')}${yellow(`${waiting} wait${waiting === 1 ? 's' : ''} on you`)}` : '')),
    ...(open.length ? apart([...open.filter(waits), ...open.filter((t) => !waits(t))].map(thread)) : [dim('  none')]),
    head('DESCRIPTION'),
    ...(d.body?.trim() ? prose(d.body, w) : [dim('  no description')]),
    head('CONVERSATION', dim(`${some(comments, 'comment')}${comments > shown ? `, the latest ${shown} shown` : ''}`)),
    ...(talk.length ? apart(talk.map((x) => [
      `  ${mine && x.asks && theirs(x.author) && at(x.when) > last ? WAIT : ''}${by(x.author, x.verb, x.when)}`,
      ...prose(x.body, w, '    ', 20),
    ])) : [dim('  none')]),
  ];
}

// A PR's place in its stack, on its page: the stack's counts and PRs, this one marked, when the dashboard has the
// stack (joined, from joinStacks()), or else a line saying where it is. [t] opens the stack's page.
function stackBlock(d, stack, w) {
  if (!d.stack) return [];
  const key = `${plain(d.repository?.name)}#${d.stack.number}`, at = d.stackEntry?.position;
  if (!stack) return [`  ${cyan(BADGE)} ${dim(`${at ? `${at} of ` : ''}${d.stack.size} in stack`)} ${blue(key)}  ${dim('[t] opens it')}`];
  const { parts, strip } = summary(stack);
  return [
    head(`STACK ${key}`, `${dim(`${at ? `${at} of ` : ''}${stack.members.length} → ${plain(stack.base)}`)}  ${strip}  ${parts.join(dim(' · '))}`),
    ...stack.members.map((m) => {
      const lead = `  ${m.number === d.number ? cyan('▸') : ' '} ${dim(String(m.position).padStart(2))} ${GLYPH[m.status]} ${pad(TAG[m.status], 8)} ${blue(`#${m.number}`)} `;
      return lead + cut(plain(m.pr.title), Math.max(10, w - cols(vis(lead))));
    }),
    dim(`  ${plain(stack.url)} · [t] opens it`),
  ];
}

// A stack's page: its base, counts and strip, the next PR to merge, then its PRs in order, from the base up, each
// with its branch onto the one below it. sel is the PR selected with j/k, which l opens.
function stackPage(s, key, w, sel = 0) {
  const { parts, strip, next, stale } = summary(s);
  const out = [
    head(`STACK ${key}`),
    ...flow([`${s.members.length} PRs → ${plain(s.base)}`, strip, ...parts, stale && dim('every open PR a draft')], w),
    ...(next ? [`  ${dim('next to merge:')} ${blue(`#${next.number}`)}${dim(`, ${NEEDS[next.status]}`)}`] : []),
    dim(`  ${plain(s.url)}`),
    head('PULL REQUESTS', dim(`${s.members.length}`)),
  ];
  s.members.forEach((m, i) => {
    const p = m.pr, lead = `${i === sel ? MARK : '  '}${dim(String(m.position).padStart(2))} ${CI[p.commits?.nodes[0]?.commit.statusCheckRollup?.state] || dim('·')} ` +
      `${pad(TAG[m.status], 8)} ${blue(`#${m.number}`)} `;
    const title = cut(plain(p.title), Math.max(10, w - cols(vis(lead))));
    out.push(lead + (i === sel ? bold(title) : !m.known || m.status === 'merged' || m.status === 'closed' ? dim(title) : title));
    out.push(...flow([
      dim(`${plain(m.head)} → ${plain(i ? s.members[i - 1].head : s.base)}`), p.author && dim(`by ${plain(p.author.login)}`),
      p.replies > 0 && yellow(`↩${p.replies}`), p.updatedAt && dim(`updated ${ago(p.updatedAt)} ago`),
    ], w, '        '));
  });
  return out;
}

// An issue's page: its state, people, labels and linked PRs, then its text, then its latest comments.
function issuePage(d, key, w) {
  const links = nodes(d.closedByPullRequestsReferences).map((p) => ({ ...p, state: linkState(p) }))
    .sort((a, b) => LINK_RANK.indexOf(a.state) - LINK_RANK.indexOf(b.state));
  const who = nodes(d.assignees).map((a) => plain(a.login)).join(', ');
  const shown = nodes(d.comments).length, comments = d.comments?.totalCount ?? shown;
  return [
    head(`ISSUE ${key}`),
    ...title(d.title, w),
    ...flow([
      d.state === 'OPEN' ? green('open') : magenta(`closed${d.stateReason ? ` as ${plain(d.stateReason).toLowerCase().replace(/_/g, ' ')}` : ''}`),
      dim(`by ${plain(d.author?.login || 'ghost')}`), who && dim(`assigned ${who}`), d.milestone && dim(`milestone ${plain(d.milestone.title)}`),
      dim(`opened ${ago(d.createdAt)} ago`), dim(`updated ${ago(d.updatedAt)} ago`),
    ], w),
    ...flow(nodes(d.labels).map(chip), w, '  ', ' '),
    ...links.map((p) => {
      const tail = ` · ${p.state.toLowerCase()}`, num = `#${p.number} `;
      return `  ${LINK[p.state] || dim('⇄')} ${blue(num)}${cut(plain(p.title), w - 4 - num.length - tail.length)}${dim(tail)}`;
    }),
    dim(`  ${plain(d.url)}`),
    head('DESCRIPTION'),
    ...(d.body?.trim() ? prose(d.body, w) : [dim('  no description')]),
    head('COMMENTS', dim(`${comments}${comments > shown ? `, the latest ${shown} shown` : ''}`)),
    ...(shown ? apart(nodes(d.comments).map((c) => [`  ${by(c.author, '', c.createdAt)}`, ...prose(c.body, w, '    ', 30)])) : [dim('  none')]),
  ];
}

// A PR's, an issue's or a stack's page, as styled lines for a pane w columns wide: from got.data, its details, once
// they're fetched, and from item, its row in the list, until then. got.err says why they couldn't be fetched. A
// stack's page is drawn from stack, joined from the stacks the dashboard has, or from got.data's; a PR's page
// shows its stack from it too.
function renderDetail({ kind, key, item, got = {}, stack, sel }, w) {
  w = Math.max(20, w - 1); // paint() leaves the last column empty
  const d = got.data;
  const lines = kind === 'stack'
    ? (stack ? stackPage(stack, key, w, sel) : [head(`STACK ${key}`), ...(got.err ? [] : [dim('  asking GitHub…')])])
    : d ? (d.__typename === 'PullRequest' ? prPage(d, key, w, stack) : issuePage(d, key, w))
    : [head(`${kind === 'pr' ? 'PR' : 'ISSUE'} ${key}`), ...title(item.title, w), ...(got.err ? [] : [dim('  asking GitHub…')])];
  if (got.err) lines.unshift(red(`  ${d || stack ? "couldn't refresh" : "couldn't fetch it"}: ${plain(got.err)}`));
  return lines.flatMap((l) => l.split('\n'));
}

module.exports = { renderDetail, prose, wrap, cut, flow, cols, checks };
