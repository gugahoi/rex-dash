'use strict';
const { json, run, firstLine } = require('../utils');

// What a PR's row needs, and what a stack's PR needs too. Its latest reviews become its status, then go.
const PR = `number title url state isDraft reviewDecision updatedAt repository { name } author { login }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
  latestOpinionatedReviews(first: 10) { nodes { state author { __typename } } }`;
// Which stack a PR is in, and where. Free: they add nothing to a query's cost.
const STACK_REFS = 'stack { id number size } stackEntry { position }';

// GitHub servers without stacks, such as older GitHub Enterprise ones, fail a query that asks for them. Then it's
// asked again without them, and so is every query after it.
const support = { stacks: true };
const ask = (query) => (support.stacks ? query : query.split(STACK_REFS).join(''));
async function orWithoutStacks(fetch) {
  try { return await fetch(); } catch (e) {
    if (!support.stacks || !/Field '(stack|stackEntry)' doesn't exist/.test(e.message)) throw e;
    support.stacks = false;
    return fetch();
  }
}

// Your PRs also fetch what replies() needs. That makes the query cost about 8 points of GitHub's 5,000 an hour,
// rather than 1: 20 threads, 10 reviews and 10 comments for each of 30 PRs.
const prQuery = (scope) => `query {
  viewer { login }
  mine: search(query: "is:pr is:open author:@me archived:false sort:updated-desc${scope}", type: ISSUE, first: 30) { issueCount nodes { ...pr ...replies } }
  review: search(query: "is:pr is:open review-requested:@me archived:false sort:updated-desc${scope}", type: ISSUE, first: 30) { issueCount nodes { ...pr } }
}
fragment pr on PullRequest {
  ${PR}
  ${STACK_REFS}
}
fragment replies on PullRequest {
  reviewThreads(last: 20) { nodes { isResolved comments(last: 1) { nodes { author { login __typename } createdAt } } } }
  reviews(last: 10) { nodes { author { login __typename } state submittedAt comments { totalCount } } }
  comments(last: 10) { nodes { author { login __typename } createdAt } }
}`;

const at = (t) => Date.parse(t) || 0;
const nodes = (c) => c?.nodes || [];
// How many replies wait on you, the user me, in your PR: unresolved review threads where someone else has the last
// word, and their comments and reviews since your last comment, review or commit. Bots don't count. A review with
// inline comments counts through its threads, and an approval needs no reply.
function replies({ reviewThreads, reviews, comments, commits }, me) {
  if (!me) return 0;
  const yours = (a) => a?.login === me, theirs = (a) => !yours(a) && a?.__typename !== 'Bot'; // a deleted account has no author
  const last = Math.max(
    at(nodes(commits)[0]?.commit.committedDate),
    ...nodes(comments).filter((c) => yours(c.author)).map((c) => at(c.createdAt)),
    ...nodes(reviews).filter((r) => yours(r.author)).map((r) => at(r.submittedAt)),
  );
  const threads = nodes(reviewThreads).filter((t) => !t.isResolved && nodes(t.comments).length && theirs(nodes(t.comments)[0].author));
  const since = [
    ...nodes(comments).map((c) => [c.author, c.createdAt]),
    ...nodes(reviews).filter((r) => ['COMMENTED', 'CHANGES_REQUESTED'].includes(r.state) && !r.comments?.totalCount).map((r) => [r.author, r.submittedAt]),
  ].filter(([a, t]) => theirs(a) && at(t) > last);
  return threads.length + since.length;
}

// A PR's status: merged, closed, draft, changes, approved or review. reviewDecision is null when the PR's base
// branch isn't protected, as in a stack, where a PR's base is the branch of the PR below it. Then its latest
// reviews decide, without bots'.
function prStatus(p) {
  if (p.state === 'MERGED') return 'merged';
  if (p.state === 'CLOSED') return 'closed';
  if (p.isDraft) return 'draft';
  const said = nodes(p.latestOpinionatedReviews).filter((r) => r.author?.__typename !== 'Bot').map((r) => r.state);
  if (p.reviewDecision === 'CHANGES_REQUESTED' || (!p.reviewDecision && said.includes('CHANGES_REQUESTED'))) return 'changes';
  if (p.reviewDecision === 'APPROVED' || (!p.reviewDecision && said.includes('APPROVED'))) return 'approved';
  return 'review';
}
// A PR keeps its status, not its reviews, which would bloat the cache.
const slim = ({ latestOpinionatedReviews, ...p }) => ({ ...p, status: prStatus({ ...p, latestOpinionatedReviews }) });

async function prs(repo, runJson = json) {
  if (repo && !repo.gh) throw new Error('no GitHub remote, so no PRs');
  const query = prQuery(repo ? ` repo:${repo.gh}` : '');
  const { data } = await orWithoutStacks(() => runJson('gh', ['api', 'graphql', '-f', `query=${ask(query)}`]));
  if (data.review?.nodes) data.review.nodes = data.review.nodes.map(slim);
  // Each of your PRs keeps only its count of replies, not the threads, reviews and comments, which would bloat the cache.
  if (data.mine?.nodes) {
    data.mine.nodes = data.mine.nodes.map(({ reviewThreads, reviews, comments, ...p }) =>
      ({ ...slim(p), replies: replies({ reviewThreads, reviews, comments, commits: p.commits }, data.viewer?.login) }));
  }
  return data;
}

const issueQuery = (scope) => `query {
  issues: search(query: "is:issue is:open ${scope} archived:false sort:updated-desc", type: ISSUE, first: 30) { issueCount nodes { ...issue } }
}
fragment issue on Issue {
  number title url updatedAt repository { name } author { login } comments { totalCount } milestone { title }
  assignees(first: 5) { nodes { login } }
  labels(first: 10) { nodes { name color } }
  closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number state isDraft } }
}`;
async function issues(repo, runJson = json) {
  if (repo && !repo.gh) throw new Error('no GitHub remote, so no issues');
  return (await runJson('gh', ['api', 'graphql', '-f', `query=${issueQuery(repo ? `repo:${repo.gh}` : 'assignee:@me')}`])).data.issues;
}

// One PR's or issue's details, for its page in the dashboard: for a PR, its unresolved threads (GitHub can't
// filter them, so the first 100 threads come), checks, reviews and latest comments; for an issue, its text and
// latest comments. It costs about 2 points, and is only fetched while its page shows. The page's URL names it,
// so this needs no repo, and works for GitHub Enterprise as gh does.
const detailQuery = `query($url: URI!) {
  viewer { login }
  resource(url: $url) {
    __typename
    ... on PullRequest {
      number title url state isDraft body createdAt updatedAt reviewDecision
      author { login } repository { name nameWithOwner }
      baseRefName headRefName additions deletions changedFiles
      ${STACK_REFS}
      commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state contexts(first: 50) { nodes {
        __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state }
      } } } } } }
      reviewThreads(first: 100) { totalCount nodes {
        isResolved isOutdated path line startLine originalLine originalStartLine subjectType
        hunk: comments(first: 1) { nodes { diffHunk } }
        comments(first: 30) { totalCount nodes { author { login __typename } body createdAt } }
      } }
      reviews(last: 20) { nodes { author { login __typename } state body submittedAt } }
      comments(last: 20) { totalCount nodes { author { login __typename } body createdAt } }
    }
    ... on Issue {
      number title url state stateReason body createdAt updatedAt
      author { login } repository { name nameWithOwner } milestone { title }
      assignees(first: 10) { nodes { login } }
      labels(first: 20) { nodes { name color } }
      closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number title state isDraft } }
      comments(last: 30) { totalCount nodes { author { login __typename } body createdAt } }
    }
  }
}`;
// The URL goes in as a variable, never in the query's text. viewer is who you are, for the replies waiting on you.
async function details(url, runJson = json) {
  const { data } = await orWithoutStacks(() => runJson('gh', ['api', 'graphql', '-f', `query=${ask(detailQuery)}`, '-f', `url=${url}`]));
  const item = data?.resource;
  if (item?.__typename !== 'PullRequest' && item?.__typename !== 'Issue') throw new Error(`GitHub has no PR or issue at ${url}`);
  return { ...item, viewer: data.viewer?.login };
}

// ---- stacks
// A gh api -i response: its status, headers and body. Its first line ends in \n, its headers in \r\n.
function http(out) {
  const end = out.search(/\r?\n\r?\n/), head = end < 0 ? out : out.slice(0, end);
  const [line = '', ...rest] = head.split(/\r?\n/), headers = {};
  for (const h of rest) {
    const i = h.indexOf(':');
    if (i > 0) headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
  }
  return { status: Number(line.match(/^HTTP\/[\d.]+ (\d{3})/)?.[1]) || 0, headers, body: end < 0 ? '' : out.slice(end).trim() };
}
// A stack's web page, from its API URL: https://api.github.com/repos/o/r/stacks/7 is https://github.com/o/r/stack/7,
// and https://host/api/v3/repos/o/r/stacks/7 is https://host/o/r/stack/7 on GitHub Enterprise.
const stackPage = (api) => String(api || '').replace('://api.github.com/repos/', '://github.com/').replace('/api/v3/repos/', '/')
  .replace(/\/stacks\/(\d+)$/, '/stack/$1');
// A stack from the REST list, as the dashboard keeps it: its PRs in order, as far as the list knows them.
const skeleton = (repo) => (s) => ({
  id: s.node_id, number: s.number, repo, base: s.base?.ref || '', url: stackPage(s.url),
  members: (s.pull_requests || []).map((p) => ({
    number: p.number, state: p.merged_at ? 'MERGED' : String(p.state || '').toUpperCase(), isDraft: !!p.draft, head: p.head?.ref || '',
  })),
});

// The repo's open stacks, newest first. GraphQL can't list them, so REST does, 100 a page, with no filter for
// open ones. Each page goes with its ETag, so a page that hasn't changed comes back as a 304, which costs nothing
// and is answered from the cache. A server without stacks answers 404: no stacks.
const STACK_PAGES = 10;
async function stackList(gh, cached, runRaw = run) {
  const pages = [], repo = gh.split('/')[1];
  for (let page = 1; page <= STACK_PAGES; page++) {
    const path = `repos/${gh}/stacks?per_page=100&page=${page}`, old = cached?.pages?.find((p) => p.path === path);
    const { code, out, err } = await runRaw('gh', ['api', '-i', ...(old?.etag ? ['-H', `If-None-Match: ${old.etag}`] : []), path]);
    const res = http(out);
    if (res.status === 304 && old) pages.push(old);
    else if (res.status === 404 && page === 1) return [];
    else if (res.status !== 200) throw new Error(firstLine(err || `gh api exited with ${code}`));
    else {
      pages.push({
        path, etag: res.headers.etag, more: /rel="next"/.test(res.headers.link || ''),
        stacks: JSON.parse(res.body || '[]').filter((s) => s.open).map(skeleton(repo)),
      });
    }
    if (!pages.at(-1).more) break;
  }
  return pages;
}

// PRs of a repo by number, as stacks need them, in queries of 50. The owner and name go in as variables; the
// numbers, checked, as the aliases they need to be.
const memberQuery = (numbers) => `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { ${numbers.map((n) => `p${n}: pullRequest(number: ${n}) { ...pr }`).join(' ')} }
}
fragment pr on PullRequest { ${PR} }`;
async function stackMembers(gh, numbers, runJson = json) {
  if (!numbers.every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('PR numbers are positive integers');
  const [owner, name] = gh.split('/'), got = {};
  for (let i = 0; i < numbers.length; i += 50) {
    const query = memberQuery(numbers.slice(i, i + 50));
    const { data } = await runJson('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`]);
    for (const p of Object.values(data?.repository || {})) if (p) got[p.number] = slim(p);
  }
  return got;
}

// The repo's open stacks, and the PRs in them that the dashboard can't take from elsewhere. A PR in your PRs or
// your review requests is taken from them when it's drawn, so it's never fetched here. A merged or closed one
// fetched before is kept, since it won't change. The rest are fetched, in one query of about 1 point. If that
// fails, the ones fetched before stand in, and err says why.
async function stacks(repo, { prs: listed, cached } = {}, runRaw = run, runJson = json) {
  if (!repo?.gh) throw new Error('no GitHub remote, so no stacks');
  const pages = await stackList(repo.gh, cached, runRaw);
  const name = repo.gh.split('/')[1], kept = cached?.prs || {};
  const known = new Set([...nodes(listed?.mine), ...nodes(listed?.review)].filter((p) => p.repository?.name === name).map((p) => p.number));
  const members = pages.flatMap((p) => p.stacks).flatMap((s) => s.members).filter((m) => !known.has(m.number));
  const wanted = [...new Set(members.filter((m) => m.state === 'OPEN' || kept[m.number]?.state !== m.state).map((m) => m.number))];
  let got = {}, err;
  if (wanted.length) try { got = await stackMembers(repo.gh, wanted, runJson); } catch (e) { err = firstLine(e); }
  const prs = {};
  for (const { number } of members) if (got[number] || kept[number]) prs[number] = got[number] || kept[number];
  return { pages, prs, ...(err && { err }) };
}

// One stack, for its page, when the dashboard doesn't have it: outside a repo, or with stacks hidden. GraphQL has
// it by its id, with its PRs, in the same shape as stacks() gives.
const stackQuery = `query($id: ID!) {
  node(id: $id) { ... on PullRequestStack { id number baseRefName entries(first: 100) { nodes { position pullRequest { ...pr headRefName } } } } }
}
fragment pr on PullRequest { ${PR} }`;
async function stack(id, runJson = json) {
  const { data } = await runJson('gh', ['api', 'graphql', '-f', `query=${stackQuery}`, '-f', `id=${id}`]);
  const s = data?.node, ps = nodes(s?.entries).sort((a, b) => a.position - b.position).map((e) => e.pullRequest).filter(Boolean);
  if (!s?.number || !ps.length) throw new Error('GitHub has no such stack');
  return {
    pages: [{ stacks: [{
      id: s.id, number: s.number, repo: ps[0].repository?.name || '', base: s.baseRefName || '',
      url: String(ps[0].url || '').replace(/\/pull\/\d+$/, `/stack/${s.number}`),
      members: ps.map((p) => ({ number: p.number, state: p.state, isDraft: p.isDraft, head: p.headRefName || '' })),
    }] }],
    prs: Object.fromEntries(ps.map(({ headRefName, ...p }) => [p.number, slim(p)])),
  };
}

module.exports = {
  prQuery, issueQuery, detailQuery, memberQuery, stackQuery, STACK_REFS, support, replies, prStatus, prs, issues, details,
  http, stackPage, stackList, stackMembers, stacks, stack,
};
