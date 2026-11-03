'use strict';
const { json } = require('../utils');

const prQuery = (scope) => `query {
  mine: search(query: "is:pr is:open author:@me archived:false sort:updated-desc${scope}", type: ISSUE, first: 30) { issueCount nodes { ...pr } }
  review: search(query: "is:pr is:open review-requested:@me archived:false sort:updated-desc${scope}", type: ISSUE, first: 30) { issueCount nodes { ...pr } }
}
fragment pr on PullRequest {
  number title url isDraft reviewDecision updatedAt repository { name }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;
async function prs(repo, runJson = json) {
  if (repo && !repo.gh) throw new Error('no GitHub remote, so no PRs');
  return (await runJson('gh', ['api', 'graphql', '-f', `query=${prQuery(repo ? ` repo:${repo.gh}` : '')}`])).data;
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

module.exports = { prQuery, issueQuery, prs, issues };
