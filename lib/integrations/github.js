'use strict';
const { json } = require('../utils');

// Your PRs also fetch what replies() needs. That makes the query cost about 8 points of GitHub's 5,000 an hour,
// rather than 1: 20 threads, 10 reviews and 10 comments for each of 30 PRs.
const prQuery = (scope) => `query {
  viewer { login }
  mine: search(query: "is:pr is:open author:@me archived:false sort:updated-desc${scope}", type: ISSUE, first: 30) { issueCount nodes { ...pr ...replies } }
  review: search(query: "is:pr is:open review-requested:@me archived:false sort:updated-desc${scope}", type: ISSUE, first: 30) { issueCount nodes { ...pr } }
}
fragment pr on PullRequest {
  number title url isDraft reviewDecision updatedAt repository { name }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
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

async function prs(repo, runJson = json) {
  if (repo && !repo.gh) throw new Error('no GitHub remote, so no PRs');
  const { data } = await runJson('gh', ['api', 'graphql', '-f', `query=${prQuery(repo ? ` repo:${repo.gh}` : '')}`]);
  // Each of your PRs keeps only its count of replies, not the threads, reviews and comments, which would bloat the cache.
  if (data.mine?.nodes) {
    data.mine.nodes = data.mine.nodes.map(({ reviewThreads, reviews, comments, ...p }) =>
      ({ ...p, replies: replies({ reviewThreads, reviews, comments, commits: p.commits }, data.viewer?.login) }));
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

module.exports = { prQuery, issueQuery, replies, prs, issues };
