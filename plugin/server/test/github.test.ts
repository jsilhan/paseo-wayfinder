import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackBlockers, GitHub, issueSchema, parseGhOutput } from "../github";
import { ticketType, revision } from "../policy";

const makeIssue = (number: number, state = "open") => ({
  id: number, number, title: "Task", body: "", state,
  html_url: `https://github.com/owner/repo/issues/${number}`,
  repository_url: "https://api.github.com/repos/owner/repo",
  labels: [{ name: "wayfinder:task" }], assignees: [],
});

test("gh pagination parses JSON lines without requiring the newer --slurp flag", () => {
  const first = [makeIssue(1)];
  const second = [makeIssue(2)];
  assert.deepEqual(parseGhOutput(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, true), [first, second]);
  assert.deepEqual(parseGhOutput("[]\n", true), [[]]);
  assert.throws(() => parseGhOutput("", true), /no JSON/);
  assert.deepEqual(parseGhOutput(JSON.stringify(first[0])), first[0]);
  assert.throws(() => parseGhOutput("not JSON", true));
});

test("strict blocker fallback supports local, qualified and URL references", () => {
  assert.deepEqual(fallbackBlockers("**Blocked by:** #12, other/repo#3 https://github.com/o/r/issues/4", "a/b"), [
    { repository: "a/b", number: 12 }, { repository: "other/repo", number: 3 }, { repository: "o/r", number: 4 },
  ]);
  assert.deepEqual(fallbackBlockers("Blocked by: none", "a/b"), []);
  for (const line of ["Blocked by:", "Blocked by #12", "Blocked by: #12 maybe",
    "Blocked by: TBD", "## Blocked by\n#12", "- [ ] Blocked by: #12"]) {
    assert.throws(() => fallbackBlockers(line, "a/b"), /Ambiguous/);
  }
});

test("GitHub lists every page and filters closed children and PRs", async () => {
  const github = new GitHub(async (path, options) => {
    assert.equal(path, "repos/owner/repo/issues/1/sub_issues?per_page=100");
    assert.equal(options?.paginate, true);
    return [[makeIssue(2), makeIssue(3, "closed")], [makeIssue(4), { ...makeIssue(5), pull_request: {} }]];
  });
  assert.deepEqual((await github.candidates("owner/repo", 1)).map((issue) => issue.number), [2, 4]);
});

test("native and fallback blockers are unioned, not alternatives", async () => {
  const github = new GitHub(async (path) => {
    if (path.includes("dependencies")) return [[makeIssue(2, "closed")], [makeIssue(3)]];
    assert.equal(path, "repos/owner/repo/issues/4");
    return makeIssue(4);
  });
  const issue = issueSchema.parse({ ...makeIssue(1), body: "Blocked by: #4" });
  assert.deepEqual((await github.blockers("owner/repo", issue)).map((blocker) => blocker.state),
    ["closed", "open", "open"]);
});

test("native API errors cannot be converted into an empty frontier gate", async () => {
  const github = new GitHub(async () => { throw new Error("403"); });
  await assert.rejects(github.blockers("owner/repo", issueSchema.parse(makeIssue(1))), /403/);
});

test("transferred issues are rejected rather than silently rebound", async () => {
  const github = new GitHub(async () => ({ ...makeIssue(1), repository_url: "https://api.github.com/repos/elsewhere/repo" }));
  await assert.rejects(github.issue("owner/repo", 1), /moved or transferred/);
});

test("routing rejects absent, ambiguous, map and inherited-property labels", () => {
  for (const labels of [[], ["wayfinder:task", "wayfinder:research"], ["wayfinder:map"], ["wayfinder:toString"]]) {
    assert.throws(() => ticketType(issueSchema.parse({
      ...makeIssue(1), labels: labels.map((name) => ({ name })),
    })), /blocked-label/);
  }
});

test("revision is insensitive to assignment footprint and label order", () => {
  const issue = issueSchema.parse(makeIssue(1));
  const assigned = { ...issue, assignees: [{ login: "human" }] };
  assert.equal(revision(issue, [], ""), revision(assigned, [], ""));
  assert.notEqual(revision(issue, [], ""), revision(issue, [], "Changed map Notes"));
});
