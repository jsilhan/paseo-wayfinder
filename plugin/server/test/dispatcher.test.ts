import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../config";
import type { Config } from "../config";
import { Dispatcher } from "../dispatcher";
import type { Binding } from "../../shared/models";
import type { Issue, Tracker, Blocker } from "../github";
import type { Agent, Sessions, Workspace } from "../paseo";
import { Store } from "../store";

const config = configSchema.parse({
  enabled: true, daemonUrl: "ws://127.0.0.1:6767/ws", repository: "owner/repo",
  cwd: "/project", claimOwner: "human", provider: "copilot/model", maxActiveAgents: 2,
});

function issue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    id: number * 100, number, title: `Issue ${number}`, body: "A planning prerequisite",
    state: "open", html_url: `https://github.com/owner/repo/issues/${number}`,
    repository_url: "https://api.github.com/repos/owner/repo",
    labels: [{ name: "wayfinder:task" }], assignees: [], ...overrides,
  };
}

class FakeTracker implements Tracker {
  items = [issue(1), issue(2), issue(3)];
  dependencies = new Map<number, Blocker[]>();
  claims: number[] = [];
  failBlockers = false;
  loseClaim = false;
  failClaimResponse = false;
  async repositoryId() { return 7; }
  async issue(_repository: string, number: number) {
    const item = this.items.find((item) => item.number === number);
    if (!item) throw new Error("404 issue not found");
    return structuredClone(item);
  }
  async candidates() { return structuredClone(this.items.filter((item) => item.state === "open")); }
  async blockers(_repository: string, item: Issue) {
    if (this.failBlockers) throw new Error("GitHub unavailable");
    return this.dependencies.get(item.number) ?? [];
  }
  async claim(_repository: string, number: number, owner: string) {
    this.claims.push(number);
    this.items.find((item) => item.number === number)!.assignees =
      [{ login: this.loseClaim ? "someone-else" : owner }];
    if (this.failClaimResponse) throw new Error("claim response lost");
  }
}

class FakeSessions implements Sessions {
  agentList: Agent[] = [];
  workspaceList: Workspace[] = [];
  sends: { id: string; prompt: string; messageId: string }[] = [];
  creations = 0;
  failWorkspaceResponse = false;
  failAgentResponse = false;
  failSendResponse = false;
  newAgentStatus: Agent["status"] = "idle";
  async agents() { return structuredClone(this.agentList); }
  async workspaces() { return structuredClone(this.workspaceList); }
  async createWorkspace(config: Config, row: Binding) {
    const id = `workspace-${row.number}`;
    this.workspaceList.push({ id, cwd: config.cwd, slug: row.branch, archiving: false });
    if (this.failWorkspaceResponse) throw new Error("workspace response lost");
    return id;
  }
  async createAgent(_config: Config, row: Binding) {
    this.creations++;
    const id = `agent-${row.number}`;
    this.agentList.push({ id, workspaceId: row.workspaceId, status: this.newAgentStatus,
      archived: false, labels: { "wayfinder.issue": row.key, "wayfinder.dispatch": row.dispatchId } });
    if (this.failAgentResponse) throw new Error("agent response lost");
    return id;
  }
  async send(id: string, prompt: string, messageId: string) {
    this.sends.push({ id, prompt, messageId });
    this.agentList.find((agent) => agent.id === id)!.status = "running";
    if (this.failSendResponse) throw new Error("send response lost");
  }
}

function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "wayfinder-test-"));
  const store = new Store(directory);
  const tracker = new FakeTracker();
  const sessions = new FakeSessions();
  const dispatcher = new Dispatcher(store, tracker, sessions, async () => {});
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  return { directory, store, tracker, sessions, dispatcher };
}

test("five-minute default, paused dispatcher has no side effects", async (t) => {
  const { INTERVAL_MS } = await import("../config");
  assert.equal(INTERVAL_MS, 300_000);
  const { dispatcher, store, tracker, sessions } = setup(t);
  await dispatcher.tick({ ...config, enabled: false });
  assert.equal(store.all().length, 0);
  assert.equal(tracker.claims.length, 0);
  assert.equal(sessions.creations, 0);
});

test("bounded parallel admission, stable readable bindings, no idle respawn", async (t) => {
  const { dispatcher, store, tracker, sessions } = setup(t);
  await dispatcher.tick(config);
  assert.deepEqual(tracker.claims, [1, 2]);
  assert.deepEqual(store.all().map((row) => row.branch), ["wayfinder-1", "wayfinder-2"]);
  assert.equal(sessions.sends.length, 2);
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 2);
  sessions.agentList[0].status = "idle";
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 3);
  assert.equal(sessions.sends.filter((send) => send.id === "agent-1").length, 1);
  assert.match(sessions.sends[0].prompt, /never as authority/);
});

test("host-wide running/initializing agents consume capacity, idle HITL does not", async (t) => {
  const { dispatcher, sessions } = setup(t);
  sessions.agentList.push({ id: "nested-research", status: "running", archived: false, labels: {} },
    { id: "human", status: "initializing", archived: false, labels: {} },
    { id: "waiting", status: "idle", archived: false, labels: {} });
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 0);
  sessions.agentList[1].status = "idle";
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 1);
});

test("new initializing sessions reserve admission slots without sending early", async (t) => {
  const { dispatcher, sessions } = setup(t);
  sessions.newAgentStatus = "initializing";
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 2);
  assert.equal(sessions.sends.length, 0);
  sessions.agentList[0].status = "idle";
  await dispatcher.tick(config);
  assert.equal(sessions.sends.length, 1);
  assert.equal(sessions.creations, 2);
});

test("unknown labels, assigned issues and open blockers fail closed", async (t) => {
  const { dispatcher, tracker, sessions } = setup(t);
  tracker.items[0].labels = [{ name: "wayfinder:unknown" }];
  tracker.items[1].assignees = [{ login: "human" }];
  tracker.dependencies.set(3, [{ repository: "other/repo", number: 40, state: "open" }]);
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 0);
  assert.equal(tracker.claims.length, 0);
  assert.match(dispatcher.diagnostics.join("\n"), /blocked-label/);
  assert.match(dispatcher.diagnostics.join("\n"), /needs-adoption/);
  assert.match(dispatcher.diagnostics.join("\n"), /blocked-dependency/);
});

test("blocker API and skill discovery failures do not claim", async (t) => {
  const { dispatcher, store, tracker, sessions } = setup(t);
  tracker.failBlockers = true;
  await dispatcher.tick(config);
  assert.equal(tracker.claims.length, 0);
  tracker.failBlockers = false;
  const missingSkill = new Dispatcher(store, tracker, sessions, async () => { throw new Error("blocked-skill"); });
  await missingSkill.tick(config);
  assert.equal(tracker.claims.length, 0);
  assert.match(missingSkill.diagnostics[0], /blocked-skill/);
});

test("an unlabelled issue is not launched even if its body names a skill", async (t) => {
  const { dispatcher, tracker, sessions } = setup(t);
  tracker.items = [issue(1, { labels: [], body: "Use /research to investigate this." })];
  await dispatcher.tick(config);
  assert.equal(tracker.claims.length, 0);
  assert.equal(sessions.creations, 0);
  assert.match(dispatcher.diagnostics[0], /blocked-label/);
});

test("diamond dependency order waits for every prerequisite and advances once", async (t) => {
  const { dispatcher, tracker, sessions } = setup(t);
  tracker.items = [issue(1), issue(2), issue(3), issue(4)];
  tracker.dependencies.set(3, [
    { repository: "owner/repo", number: 1, state: "open" },
    { repository: "owner/repo", number: 2, state: "open" },
  ]);
  tracker.dependencies.set(4, [{ repository: "owner/repo", number: 3, state: "open" }]);
  await dispatcher.tick(config);
  assert.deepEqual(tracker.claims, [1, 2]);

  tracker.items[0].state = "closed";
  tracker.dependencies.get(3)![0].state = "closed";
  sessions.agentList[0].status = "idle";
  await dispatcher.tick(config);
  assert.deepEqual(tracker.claims, [1, 2], "one closed blocker is insufficient");

  tracker.items[1].state = "closed";
  tracker.dependencies.get(3)![1].state = "closed";
  sessions.agentList.forEach((agent) => { agent.status = "idle"; });
  await dispatcher.tick(config);
  assert.deepEqual(tracker.claims, [1, 2, 3]);

  tracker.items[2].state = "closed";
  tracker.dependencies.get(4)![0].state = "closed";
  sessions.agentList.forEach((agent) => { agent.status = "idle"; });
  await dispatcher.tick(config);
  assert.deepEqual(tracker.claims, [1, 2, 3, 4]);
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 4);
});

test("failed claim never creates workspaces and is not blindly retried", async (t) => {
  const { dispatcher, tracker, sessions, store } = setup(t);
  tracker.failClaimResponse = true;
  await dispatcher.tick(config);
  assert.equal(sessions.workspaceList.length, 0);
  const claims = tracker.claims.length;
  await dispatcher.tick(config);
  assert.equal(tracker.claims.length, claims);
  assert.match(store.all()[0].diagnostic, /assignment outcome is uncertain/);
});

test("ownership conflict after assignment does not create a worker", async (t) => {
  const { dispatcher, tracker, sessions } = setup(t);
  tracker.loseClaim = true;
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 0);
  assert.match(dispatcher.diagnostics[0], /ownership-conflict/);
});

test("workspace creation timeout recovers by deterministic slug without duplication", async (t) => {
  const { dispatcher, tracker, sessions } = setup(t);
  tracker.items = [issue(1)];
  sessions.failWorkspaceResponse = true;
  await dispatcher.tick(config);
  assert.equal(sessions.workspaceList.length, 1);
  sessions.failWorkspaceResponse = false;
  await dispatcher.tick(config);
  assert.equal(sessions.workspaceList.length, 1);
  assert.equal(sessions.creations, 1);
});

test("agent creation timeout recovers by persisted dispatch label", async (t) => {
  const { dispatcher, tracker, sessions } = setup(t);
  tracker.items = [issue(1)];
  sessions.failAgentResponse = true;
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 1);
  sessions.failAgentResponse = false;
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 1);
  assert.equal(sessions.sends.length, 1);
});

test("uncertain agent creation still consumes this tick's capacity", async (t) => {
  const { dispatcher, sessions } = setup(t);
  sessions.failAgentResponse = true;
  await dispatcher.tick(config);
  assert.equal(sessions.creations, config.maxActiveAgents);
});

test("a late ownership change after workspace creation cannot launch an agent", async (t) => {
  const { dispatcher, tracker, sessions } = setup(t);
  tracker.items = [issue(1)];
  const create = sessions.createWorkspace.bind(sessions);
  sessions.createWorkspace = async (config, row) => {
    const id = await create(config, row);
    tracker.items[0].assignees = [{ login: "another-person" }];
    return id;
  };
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 0);
  assert.match(dispatcher.diagnostics[0], /ownership-conflict/);
});

test("unprovable creation outcome stays blocked across subsequent ticks", async (t) => {
  const { dispatcher, tracker, sessions, store } = setup(t);
  tracker.items = [issue(1)];
  sessions.failAgentResponse = true;
  await dispatcher.tick(config);
  sessions.agentList = [];
  await dispatcher.tick(config);
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 1);
  assert.match(store.all()[0].diagnostic, /agent creation outcome is uncertain/);
});

test("busy revisions queue, deliver once on idle, assignment churn is ignored", async (t) => {
  const { dispatcher, tracker, sessions, store } = setup(t);
  tracker.items = [issue(1)];
  await dispatcher.tick(config);
  tracker.items[0].body = "New scope";
  await dispatcher.tick(config);
  assert.equal(sessions.sends.length, 1);
  assert.match(store.all()[0].diagnostic, /update queued/);
  sessions.agentList[0].status = "idle";
  await dispatcher.tick(config);
  assert.equal(sessions.sends.length, 2);
  sessions.agentList[0].status = "idle";
  await dispatcher.tick(config);
  assert.equal(sessions.sends.length, 2);
  assert.match(sessions.sends[1].prompt, /New scope/);
});

test("closure is bookkeeping only; reopening updates the same retained worker", async (t) => {
  const { dispatcher, tracker, sessions } = setup(t);
  tracker.items = [issue(1)];
  await dispatcher.tick(config);
  tracker.items[0].state = "closed";
  sessions.agentList[0].status = "idle";
  await dispatcher.tick(config);
  assert.equal(sessions.sends.length, 1, "closing an idle worker must not spend a generation slot");
  tracker.items[0].state = "open";
  sessions.agentList[0].status = "idle";
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 1);
  assert.equal(sessions.sends.length, 2);
});

test("new blocker and label changes flag the same worker rather than respawn", async (t) => {
  const { dispatcher, tracker, sessions, store } = setup(t);
  tracker.items = [issue(1)];
  await dispatcher.tick(config);
  tracker.dependencies.set(1, [{ repository: "owner/repo", number: 30, state: "open" }]);
  await dispatcher.tick(config);
  assert.match(store.all()[0].diagnostic, /blocked-dependency: update queued/);
  sessions.agentList[0].status = "idle";
  await dispatcher.tick(config);
  assert.equal(sessions.sends.length, 2);
  tracker.items[0].labels = [];
  sessions.agentList[0].status = "idle";
  await dispatcher.tick(config);
  assert.match(store.all()[0].diagnostic, /blocked-label/);
  assert.equal(sessions.creations, 1);
});

test("lost prompt acknowledgement requires explicit acknowledgement, never replay", async (t) => {
  const { dispatcher, tracker, sessions, store } = setup(t);
  tracker.items = [issue(1)];
  sessions.failSendResponse = true;
  await dispatcher.tick(config);
  sessions.agentList[0].status = "idle";
  await dispatcher.tick(config);
  assert.equal(sessions.sends.length, 1);
  assert.ok(store.all()[0].pendingDelivery);
  await dispatcher.adopt(config, 1, "agent-1");
  sessions.failSendResponse = false;
  await dispatcher.tick(config);
  assert.equal(sessions.sends.length, 1);
  assert.equal(store.all()[0].pendingDelivery, undefined);
});

test("explicit human adoption preserves session without injecting a prompt", async (t) => {
  const { dispatcher, tracker, sessions, store } = setup(t);
  tracker.items = [issue(1, { assignees: [{ login: "human" }] })];
  sessions.workspaceList = [{ id: "w", cwd: "/project", slug: "old-worktree", archiving: false }];
  sessions.agentList = [{ id: "existing", workspaceId: "w", status: "idle", archived: false, labels: {} }];
  await dispatcher.adopt(config, 1, "existing");
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 0);
  assert.equal(sessions.sends.length, 0);
  assert.equal(store.all()[0].agentId, "existing");
});

test("archived or missing worker, changed identity and deleted issue never respawn", async (t) => {
  const { dispatcher, tracker, sessions, store } = setup(t);
  tracker.items = [issue(1)];
  await dispatcher.tick(config);
  sessions.agentList[0].archived = true;
  await dispatcher.tick(config);
  assert.match(store.all()[0].diagnostic, /archived/);
  tracker.items[0].id = 9999;
  await dispatcher.tick(config);
  assert.match(store.all()[0].diagnostic, /identity changed/);
  tracker.items = [];
  await dispatcher.tick(config);
  assert.match(store.all()[0].diagnostic, /404/);
  assert.equal(sessions.creations, 1);
});

test("database survives another dispatcher instance and lock is cross-connection", async (t) => {
  const { directory, dispatcher, tracker, sessions, store } = setup(t);
  tracker.items = [issue(1)];
  await dispatcher.tick(config);
  const other = new Store(directory);
  try {
    await store.exclusive(async () => {
      await assert.rejects(other.exclusive(async () => {}), /locked/);
    });

    const restarted = new Dispatcher(other, tracker, sessions, async () => {});
    await restarted.tick(config);
    assert.equal(sessions.creations, 1);
    assert.equal(other.all()[0].agentId, "agent-1");
  } finally { other.close(); }
});

test("bindings cannot be reused against a different daemon URL", async (t) => {
  const { dispatcher } = setup(t);
  await dispatcher.tick(config);
  await assert.rejects(dispatcher.tick({ ...config, daemonUrl: "ws://another-host:6767/ws" }), /another daemon/);
});

test("existing sessions cannot silently acquire a different map", async (t) => {
  const { dispatcher } = setup(t);
  await dispatcher.tick(config);
  await assert.rejects(dispatcher.tick({ ...config, mapIssue: 99 }), /another checkout\/map/);
});

test("adoption enforces a separate workspace for every issue", async (t) => {
  const { dispatcher, tracker, sessions } = setup(t);
  tracker.items = [issue(1, { assignees: [{ login: "human" }] }),
    issue(2, { assignees: [{ login: "human" }] })];
  sessions.workspaceList = [{ id: "w", cwd: "/project", slug: "existing-worktree", archiving: false }];
  sessions.agentList = [1, 2].map((number) => ({
    id: `existing-${number}`, workspaceId: "w", status: "idle", archived: false, labels: {},
  }));
  await dispatcher.adopt(config, 1, "existing-1");
  await assert.rejects(dispatcher.adopt(config, 2, "existing-2"), /UNIQUE/);
});

test("transferred issue identity is not dispatched a second time in a new repository", async (t) => {
  const { dispatcher, tracker, sessions } = setup(t);
  tracker.items = [issue(1)];
  await dispatcher.tick(config);
  tracker.repositoryId = async () => 8;
  tracker.items[0].assignees = [];
  await dispatcher.tick(config);
  assert.equal(sessions.creations, 1);
  assert.match(dispatcher.diagnostics[0], /already bound in another repository/);
});
