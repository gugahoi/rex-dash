'use strict';
const { spawn } = require('node:child_process');
const { PROJECTS, dim, bold, red, green, cyan, plain, tilde, ago, firstLine } = require('./utils');
const { detectRepo, githubName, named } = require('./repo');
const { createCache } = require('./storage');
const { fleet, focusPane } = require('./integrations/rex');
const { runWorktree } = require('./integrations/wt');
const { prs, issues } = require('./integrations/github');
const { createUsage } = require('./usage');
const { createEffects, SHADERS, EFFECTS, BAND, shaded, cycle } = require('./ui/effects');
const { createFilter } = require('./ui/filter');
const { createSections, PR_ROWS, ghKey, head } = require('./ui/sections');
const { createScreen } = require('./ui/screen');

const CURSOR = '\x1b[7m \x1b[27m';

function createApp({ once = false, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout } = {}) {
  let repo = null, cache = null, usageClient = null;
  const state = {}, busy = new Map(), fetched = {}, stale = new Set();
  const effects = createEffects({ once }), filter = createFilter();
  let typing = false, sel = null, flash = null, handedOver = false;
  const { paneLines, paneSession, renderFleet, shownPRs, renderPRs, issueLines, renderIssues, renderUsage } =
    createSections({ getRepo: () => repo, getSel: () => sel, filter });
  const showing = (key) => (state[key + 'Err'] ? null : state[key]);
  const agents = () => (showing('fleet') || []).flatMap((s) => s.panes).filter((p) => p.rec);
  const shownAgents = () => filter.shown(agents(), paneLines, paneSession);
  const shownIssues = () => filter.shown(showing('issues')?.nodes || [], issueLines);
  const screen = createScreen({ frame, effects, output: stdout, isPaused: () => handedOver, once });
  const say = (text) => { flash = { text, until: Date.now() + 4e3 }; screen.draw(); };

  function setQuery(q) {
    filter.setQuery(q);
    const best = selectable().reduce((b, x) => (!b || x.score > b.score ? x : b), null); // the first of equals
    if (filter.terms.length && best) sel = best.key;
  }

  const DOWN = ['\x1b[B', '\x1bOB', '\x0e', '\n'], UP = ['\x1b[A', '\x1bOA', '\x10', '\x0b']; // arrows, ctrl-n/p, ctrl-j/k
  // While the filter is typed, keys edit it and the arrows select. Enter keeps it, esc or ctrl-c clears it,
  // and backspace on an empty query leaves it.
  function filterKey(s) {
    if (s === '\r') typing = false;
    else if (s === '\x1b' || s === '\x03') { typing = false; setQuery(''); }
    else if (DOWN.includes(s)) move(1);
    else if (UP.includes(s)) move(-1);
    else if (s === '\x7f' || s === '\b') { if (filter.query) setQuery([...filter.query].slice(0, -1).join('')); else typing = false; }
    else if (s === '\x15') setQuery(''); // ctrl-u
    else if (s === '\x17') setQuery(filter.query.replace(/\S*\s*$/, '')); // ctrl-w: the last word
    else if (!/[\x00-\x1f\x7f-\x9f]/.test(s)) setQuery(filter.query + s); // not other keys' escape codes
  }

  // A PR's or issue's repo#number is unique since they share one number sequence.
  // What j/k select, in screen order: the agents, PRs and issues on screen that the filter keeps.
  const selectable = () => [
    ...shownAgents().map((x) => ({ ...x, kind: 'agent', key: x.item.blockId })),
    ...[showing('prs')?.review, showing('prs')?.mine].filter(Boolean).flatMap((l) => shownPRs(l).slice(0, PR_ROWS))
      .map((x) => ({ ...x, kind: 'pr', key: ghKey(x.item) })),
    ...shownIssues().map((x) => ({ ...x, kind: 'issue', key: ghKey(x.item) })),
  ];

  function move(d) {
    const keys = selectable().map((x) => x.key);
    if (!keys.length) return;
    const i = keys.indexOf(sel);
    sel = keys[i < 0 ? 0 : Math.min(keys.length - 1, Math.max(0, i + d))];
  }

  function open() {
    const x = selectable().find((y) => y.key === sel);
    if (!x) return say(dim('pick an agent, PR or issue with j/k first'));
    return x.kind === 'agent' ? jump(x.item) : worktree(x.kind, x.item.number);
  }

  // The selected PR's or issue's page, or why there's none: data cached before URLs were fetched has no link
  // until it refreshes. Only web pages, since the opener would run anything else.
  function page() {
    const x = selectable().find((y) => y.key === sel);
    if (x?.kind !== 'pr' && x?.kind !== 'issue') return { why: 'pick a PR or issue with j/k first' };
    if (!/^https?:\/\//.test(x.item.url || '')) return { why: 'no link yet: wait for the refresh' };
    return { key: x.key, url: x.item.url };
  }

  // [o] opens the page in the browser, with the system's opener, on the machine rex-dash runs on.
  function browse() {
    const p = page();
    if (!p.url) return say(dim(p.why));
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [p.url], { stdio: 'ignore' })
      .on('error', (e) => say(red(e.code === 'ENOENT' ? `${opener} not found` : plain(firstLine(e)))))
      .on('exit', (code) => code && say(red(`${opener} exited with ${code}`)));
    say(green(`↗ ${plain(p.key)}`));
  }

  async function jump(p) {
    try {
      await focusPane(p); // REX_CLIENT selects the connected app.
      say(green(`→ ${plain(p.session)}`));
    } catch (e) {
      say(red(plain(firstLine(e))));
    }
  }

  // `wt issue <number>` and `wt pr <number>` open the issue's or PR's worktree by wt's rules. For an issue, wt
  // offers its <number>-* branches, or a new one named in a prompt; for a PR, it takes the PR's branch, fetched
  // from GitHub when there's no local one (a fork's as pr-<number>). Then it creates the worktree, runs
  // wt.setupCommand and opens the worktree's session (in Rex, inside Rex). Its prompts and setup need the
  // terminal, so the dashboard hands it over until wt exits, and keeps what a failing wt printed on screen
  // until a key. kind: 'issue' or 'pr'.
  async function worktree(kind, number) {
    if (!repo) return say(dim(`start rex-dash in the repo to open a worktree for its ${kind === 'pr' ? 'PR' : 'issue'}`));
    try {
      const end = await runWorktree(kind, number, { stdin, stdout, onHandoff: (value) => { handedOver = value; } });
      screen.repaint();
      if (end.error) say(red(end.error.code === 'ENOENT' ? 'wt not found: brew install gugahoi/tap/wt' : plain(firstLine(end.error))));
    } catch (e) {
      screen.repaint();
      say(red(plain(firstLine(e))));
    }
  }

  function frame() {
    const section = (key, render, loading) =>
      state[key + 'Err'] ? [head(key.toUpperCase()), red('  ' + plain(state[key + 'Err']))] : state[key] ? render(state[key]) : [head(key.toUpperCase()), dim('  ' + loading)];
    const keys = typing ? `${cyan('/')}${bold(plain(filter.query))}${CURSOR}  ${dim('[⏎] keep  [esc] clear  [↑/↓] select')}`
      : `${filter.query ? `${cyan('/')}${bold(plain(filter.query))}  ${dim('[esc] clear')}  ` : ''}${dim('[j/k] select  [⏎] open  [o] browser  [/] filter  [s] shader')} ${shaded(effects.fx.shader)}  ${dim('[e] fx')} ${shaded(effects.fx.effect)}  ${dim('[r] refresh  [q] quit')}`;
    return [
      `${bold(shaded('REX // COCKPIT'))} ${dim('·')} ${repo ? `${bold(plain(repo.name))} ${dim('·')} ` : ''}${new Date().toString().slice(0, 21)}` +
        (stale.size ? `  ${dim(`cached ${ago(Math.min(...[...stale].map((k) => fetched[k])))}`)}` : '') +
        (flash && Date.now() < flash.until ? `  ${flash.text}` : ''),
      ...(once ? [] : [keys, BAND]),
      ...section('fleet', renderFleet, 'asking Rex…'),
      ...section('usage', renderUsage, `reading ${tilde(PROJECTS)}…`),
      ...section('prs', renderPRs, 'asking GitHub…'),
      ...section('issues', renderIssues, 'asking GitHub…'),
    ].flatMap((l) => l.split('\n'));
  }

  const quit = () => { save(); stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l'); process.exit(0); };
  // One key: a character, or an arrow's (or another key's) escape code. The caller draws.
  function press(s) {
    if (typing) return filterKey(s);
    if (s === 'q' || s === '\x03') quit();
    if (s === 'r') refreshAll();
    if (s === 'o') browse();
    if (s === 'j' || DOWN.includes(s)) move(1);
    if (s === 'k' || UP.includes(s)) move(-1);
    if (s === '\r') open();
    if (s === '/') typing = true; // a kept filter is edited
    if (s === '\x1b') setQuery('');
    if (s === 's') { effects.fx.shader = cycle(Object.keys(SHADERS), effects.fx.shader); effects.saveFx(); }
    if (s === 'e') { effects.fx.effect = cycle(EFFECTS, effects.fx.effect); effects.saveFx(); }
  }
  const KEY = /\x1b\[[0-9;]*[~A-Za-z]|\x1bO[A-Za-z]|[\s\S]/gu;

  function refresh(key, fn) {
    if (!busy.has(key)) busy.set(key, (async () => {
      try { state[key] = await fn(); fetched[key] = Date.now(); delete state[key + 'Err']; } catch (e) { state[key + 'Err'] = firstLine(e); }
      busy.delete(key);
      stale.delete(key);
      if (key !== 'fleet') save(); // the fleet changes every few seconds: the others' saves, and quitting, take it along
      screen.draw();
    })());
    return busy.get(key);
  }

  const SOURCES = { fleet: [() => fleet(repo), 3e3], prs: [() => prs(repo), 60e3], issues: [() => issues(repo), 60e3], usage: [() => usageClient(), 300e3] };
  const refreshAll = () => Object.entries(SOURCES).map(([k, [fn]]) => refresh(k, fn));

  const save = () => cache.write('state.json', {
    gh: repo?.gh, fetched, state: Object.fromEntries(Object.keys(SOURCES).filter((k) => state[k]).map((k) => [k, state[k]])),
  });
  function restore(saved) {
    for (const k of Object.keys(SOURCES)) {
      if (!saved?.state?.[k] || !saved.fetched?.[k]) continue;
      state[k] = saved.state[k]; fetched[k] = saved.fetched[k]; stale.add(k);
    }
  }

  async function main() {
    const dir = cwd;
    repo = await detectRepo(dir);
    cache = createCache(repo);
    usageClient = createUsage(repo, cache);
    const saved = cache.read('state.json');
    if (repo) {
      // A cached GitHub name is used at once and checked behind it. If it changed, PRs and issues are
      // fetched again, after any fetch for the old name finishes.
      const check = githubName(dir);
      named(repo, saved && 'gh' in saved ? saved.gh : await check);
      check.then((gh) => {
        if (gh === repo.gh) return;
        named(repo, gh);
        for (const k of ['prs', 'issues']) Promise.resolve(busy.get(k)).then(() => refresh(k, SOURCES[k][0]));
      });
    }
    restore(saved);
    if (once) {
      await Promise.all(refreshAll());
      save();
      return stdout.write(frame().map((l) => effects.paint(l, 0, Infinity, 0)).join('\n') + '\n');
    }
    effects.loadFx(); // --once prints plain
    stdout.write('\x1b[?1049h\x1b[?25l');
    process.on('SIGINT', () => handedOver || quit()).on('SIGTERM', quit).on('SIGHUP', quit); // Ctrl-C in wt's setup is wt's
    stdout.on('resize', () => handedOver || screen.repaint());
    if (stdin.isTTY) {
      stdin.setRawMode(true).resume().on('data', (chunk) => {
        // Keys typed quickly, or pasted, arrive in one chunk, so handle them one at a time, until wt takes the terminal.
        for (const s of chunk.toString().match(KEY) || []) {
          if (handedOver) break;
          press(s);
        }
        screen.draw();
      });
    }
    screen.draw();
    await refresh('fleet', SOURCES.fleet[0]); // the usage scan blocks the event loop, so show the fleet first
    refreshAll();
    for (const [k, [fn, every]] of Object.entries(SOURCES)) setInterval(() => refresh(k, fn), every);
    setInterval(() => screen.draw(), 100); // 10 fps for the shader, and it keeps the clock and "ago" columns moving
  }

  return { main, frame, press, selectable, setQuery, page, refreshAll, state };
}
module.exports = { createApp };
