import { randomUUID } from "node:crypto";
import type { Config } from "./config";
import type { Binding } from "../shared/models";
import { issueRepository, type Issue, type Tracker } from "./github";
import type { Sessions, Agent } from "./paseo";
import { checkSkills, revision, ticketType, workerPrompt, type TicketType } from "./policy";
import { Store } from "./store";

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Dispatcher {
  diagnostics: string[] = [];

  constructor(
    readonly store: Store,
    private readonly tracker: Tracker,
    private readonly sessions: Sessions,
    private readonly skills: (config: Config, type: TicketType) => Promise<void> = checkSkills,
  ) {}

  private save(row: Binding, diagnostic: string): void {
    row.diagnostic = diagnostic;
    this.store.save(row);
  }

  private owned(issue: Issue, config: Config): boolean {
    return issue.assignees.length === 1 &&
      issue.assignees[0].login.toLowerCase() === config.claimOwner.toLowerCase();
  }

  private async eligible(config: Config, issue: Issue): Promise<void> {
    if (issue.state !== "open" || issue.pull_request) throw new Error("Issue is not an open task");
    await this.skills(config, ticketType(issue));
    const blockers = await this.tracker.blockers(config.repository, issue);
    if (blockers.some((blocker) => blocker.state !== "closed")) throw new Error("blocked-dependency");
  }

  async tick(config: Config): Promise<void> {
    if (!config.enabled) return;
    await this.store.exclusive(async () => {
      this.store.bindHost(config.daemonUrl);
      this.diagnostics = [];
      const repositoryId = await this.tracker.repositoryId(config.repository);
      this.store.bindProject(repositoryId, config.cwd, config.mapIssue);
      const map = config.mapIssue === null ? null : await this.tracker.issue(config.repository, config.mapIssue);
      if (map && (map.state !== "open" || !map.labels.some((label) => label.name === "wayfinder:map"))) {
        throw new Error("Parent map is closed or lacks wayfinder:map; dispatcher paused");
      }
      const mapBody = map?.body ?? "";
      const candidates = await this.tracker.candidates(config.repository, config.mapIssue);
      const rows = this.store.all();
      const known = new Set(rows.map((row) => row.key));
      const issueBindings = new Map(rows.map((row) => [row.key.split(":")[1], row.key]));
      // Include every active host agent, including nested research and unrelated workloads.
      const active = await this.sessions.agents();
      let slots = Math.max(0, config.maxActiveAgents -
        active.filter((agent) => !agent.archived && ["running", "initializing"].includes(agent.status)).length);
      const processRow = async (row: Binding) => {
        const hadAgent = Boolean(row.agentId);
        try {
          if (await this.reconcile(config, repositoryId, row, mapBody, slots > 0)) slots--;
        } catch (error) {
          if (!hadAgent && (row.phase === "agent-pending" || row.phase === "active")) slots--;
          this.save(row, message(error));
          this.diagnostics.push(`${row.repository}#${row.number}: ${message(error)}`);
        }
      };
      // Closed, missing and transferred issues must be reconciled too, not only the frontier.
      for (const row of rows.filter((row) => row.key.startsWith(`${repositoryId}:`))) {
        await processRow(row);
      }
      for (const candidate of candidates.sort((a, b) => a.number - b.number)) {
        const key = `${repositoryId}:${candidate.id}`;
        if (known.has(key)) continue;
        try {
          if (issueBindings.has(String(candidate.id))) {
            throw new Error("needs-recovery: issue identity is already bound in another repository");
          }
          if (issueRepository(candidate).toLowerCase() !== config.repository.toLowerCase()) {
            throw new Error("Cross-repository subissue requires its own dispatcher configuration");
          }
          if (candidate.number === config.mapIssue) continue;
          await this.eligible(config, candidate);
          if (candidate.assignees.length) throw new Error("needs-adoption: already assigned");
          const existing = active.filter((agent) => agent.labels["wayfinder.issue"] === key);
          if (existing.length) throw new Error("needs-adoption: session evidence exists without a binding");
          if (slots <= 0) throw new Error("waiting-capacity");
          const row: Binding = {
            key, repository: config.repository, number: candidate.number,
            dispatchId: randomUUID(), branch: `${config.prefix}-${candidate.number}`,
            phase: "reserved", diagnostic: "reserved",
          };
          this.store.save(row);
          known.add(key);
          await processRow(row);
        } catch (error) {
          this.diagnostics.push(`${config.repository}#${candidate.number}: ${message(error)}`);
        }
      }
    });
  }

  private async reconcile(config: Config, repositoryId: number, row: Binding,
    mapBody: string, capacity: boolean): Promise<boolean> {
    const issue = await this.tracker.issue(config.repository, row.number);
    if (row.key !== `${repositoryId}:${issue.id}`) throw new Error("Issue identity changed; needs-recovery");
    if (row.repository !== config.repository) {
      row.repository = config.repository;
      this.store.save(row);
    }

    if (row.agentId) return this.reconcileAgent(config, row, issue, mapBody, capacity);

    if (row.phase === "claiming") {
      throw new Error("needs-recovery: assignment outcome is uncertain; explicitly adopt an existing session");
    }
    await this.eligible(config, issue);
    if (row.phase !== "reserved" && !this.owned(issue, config)) {
      throw new Error("ownership-conflict: claim changed; not stealing or releasing it");
    }

    await this.recoverCreation(config, row);
    if (row.agentId) return this.reconcileAgent(config, row, issue, mapBody, capacity);
    if (!capacity) return this.waitForCapacity(row);

    if (row.phase === "reserved") await this.claimIssue(config, row, issue);
    if (row.phase === "claimed") await this.createWorkspace(config, row);
    return this.startWorker(config, row, mapBody);
  }

  private waitForCapacity(row: Binding): false {
    this.save(row, "waiting-capacity");
    return false;
  }

  private async claimIssue(config: Config, row: Binding, issue: Issue): Promise<void> {
    if (issue.assignees.length) throw new Error("needs-adoption: assigned after reservation");
    const workspaces = await this.sessions.workspaces();
    if (workspaces.some((workspace) => workspace.cwd === config.cwd && workspace.slug === row.branch)) {
      throw new Error("needs-adoption: deterministic workspace already exists");
    }
    row.phase = "claiming";
    this.save(row, "claiming");
    await this.tracker.claim(config.repository, issue.number, config.claimOwner);
    const claimed = await this.tracker.issue(config.repository, issue.number);
    if (!this.owned(claimed, config)) throw new Error("ownership-conflict after claim");
    await this.eligible(config, claimed);
    row.phase = "claimed";
    this.save(row, "claimed");
  }

  private async recoverCreation(config: Config, row: Binding): Promise<void> {
    if (row.phase === "workspace-pending") {
      const matches = (await this.sessions.workspaces()).filter((workspace) =>
        workspace.cwd === config.cwd && workspace.slug === row.branch && !workspace.archiving);
      if (matches.length !== 1) throw new Error("needs-recovery: workspace creation outcome is uncertain");
      row.workspaceId = matches[0].id;
      row.phase = "workspace";
      this.save(row, "recovered workspace");
    }
    if (row.phase === "agent-pending") {
      const matches = (await this.sessions.agents()).filter((agent) =>
        agent.labels["wayfinder.issue"] === row.key && agent.labels["wayfinder.dispatch"] === row.dispatchId);
      if (matches.length !== 1 || matches[0].workspaceId !== row.workspaceId) {
        throw new Error("needs-recovery: agent creation outcome is uncertain");
      }
      row.agentId = matches[0].id;
      row.phase = "active";
      this.save(row, "recovered agent");
    }
  }

  private async createWorkspace(config: Config, row: Binding): Promise<void> {
    row.phase = "workspace-pending";
    this.save(row, "creating workspace");
    row.workspaceId = await this.sessions.createWorkspace(config, row);
    row.phase = "workspace";
    this.save(row, "workspace created");
  }

  private async startWorker(config: Config, row: Binding, mapBody: string): Promise<boolean> {
    if (row.phase !== "workspace") throw new Error(`Unexpected dispatch phase: ${row.phase}`);
    const workspace = (await this.sessions.workspaces()).find((workspace) => workspace.id === row.workspaceId);
    if (!workspace || workspace.archiving || workspace.cwd !== config.cwd) {
      throw new Error("needs-recovery: workspace is missing, archived or moved");
    }
    const issue = await this.tracker.issue(config.repository, row.number);
    await this.eligible(config, issue);
    if (!this.owned(issue, config)) throw new Error("ownership-conflict before agent creation");
    if (!this.hasCapacity(config, await this.sessions.agents())) return this.waitForCapacity(row);

    row.phase = "agent-pending";
    this.save(row, "creating agent");
    row.agentId = await this.sessions.createAgent(config, row);
    row.phase = "active";
    this.save(row, "agent created; awaiting idle");
    await this.reconcileAgent(config, row, issue, mapBody, true);
    // Initialization also consumes this tick's admission slot.
    return true;
  }

  private async reconcileAgent(config: Config, row: Binding, issue: Issue,
    mapBody: string, capacity: boolean): Promise<boolean> {
    const agents = await this.sessions.agents();
    const agent = agents.find((agent) => agent.id === row.agentId);
    this.assertLiveBinding(row, agent);
    const workspace = (await this.sessions.workspaces()).find((workspace) => workspace.id === row.workspaceId);
    if (!workspace || workspace.cwd !== config.cwd || workspace.archiving) {
      throw new Error("needs-recovery: bound workspace is missing, moved or archiving");
    }
    if (row.pendingDelivery) throw new Error("needs-recovery: prompt acceptance is uncertain; inspect the existing session");
    if (!this.owned(issue, config)) throw new Error("ownership-conflict: mapped session retained, no prompt delivered");
    const blockers = await this.tracker.blockers(config.repository, issue);
    const nextRevision = revision(issue, blockers, mapBody);
    if (row.deliveredRevision === nextRevision) {
      this.save(row, issue.state === "closed" ? "closed: session retained" : `${agent.status}: session retained`);
      return false;
    }
    if (issue.state === "closed" && agent.status === "idle") {
      row.deliveredRevision = nextRevision;
      this.save(row, "closed: session retained");
      return false;
    }
    let gate = issue.state === "closed" ? "closed" :
      blockers.some((blocker) => blocker.state === "open") ? "blocked-dependency" : "ready";
    try { await this.skills(config, ticketType(issue)); } catch (error) { gate = message(error); }
    if (!row.deliveredRevision && gate !== "ready") {
      this.save(row, gate);
      return false;
    }
    if (agent.status !== "idle" || !capacity || !this.hasCapacity(config, agents)) {
      this.save(row, `${gate}: update queued (${agent.status !== "idle" ? agent.status : "waiting-capacity"})`);
      return false;
    }
    row.pendingDelivery = nextRevision;
    this.save(row, "delivering update");
    await this.sessions.send(agent.id,
      workerPrompt(config, row, issue, blockers, mapBody, Boolean(row.deliveredRevision)),
      `${row.dispatchId}:${nextRevision}`);
    row.deliveredRevision = nextRevision;
    delete row.pendingDelivery;
    this.save(row, `${gate}: update delivered`);
    return true;
  }

  private hasCapacity(config: Config, agents: Agent[]): boolean {
    return agents.filter((agent) => !agent.archived &&
      (agent.status === "running" || agent.status === "initializing")).length < config.maxActiveAgents;
  }

  private assertLiveBinding(row: Binding, agent: Agent | undefined): asserts agent is Agent {
    if (!agent || agent.archived || agent.status === "closed" || agent.status === "error") {
      throw new Error("needs-recovery: mapped session is missing, archived, closed or errored; never respawning");
    }
    if (agent.workspaceId !== row.workspaceId) throw new Error("needs-recovery: session workspace changed");
  }

  async adopt(config: Config, issueNumber: number, agentId: string): Promise<void> {
    await this.store.exclusive(async () => {
      this.store.bindHost(config.daemonUrl);
      const issue = await this.tracker.issue(config.repository, issueNumber);
      if (!this.owned(issue, config)) throw new Error("Adoption requires the configured claim owner's sole assignment");
      if (config.mapIssue === null) ticketType(issue);
      else if (!(await this.tracker.candidates(config.repository, config.mapIssue))
        .some((candidate) => candidate.id === issue.id)) throw new Error("Issue is not an open child of the configured map");
      const repositoryId = await this.tracker.repositoryId(config.repository);
      this.store.bindProject(repositoryId, config.cwd, config.mapIssue);
      const key = `${repositoryId}:${issue.id}`;
      const agent = (await this.sessions.agents()).find((agent) => agent.id === agentId);
      if (!agent?.workspaceId) throw new Error("Adoption requires an existing workspace-bound session");
      if (agent.labels["wayfinder.issue"] && agent.labels["wayfinder.issue"] !== key) {
        throw new Error("Agent is already labeled for a different issue");
      }
      const workspace = (await this.sessions.workspaces()).find((workspace) => workspace.id === agent.workspaceId);
      if (!workspace || workspace.cwd !== config.cwd || workspace.archiving || !workspace.slug) {
        throw new Error("Adoption requires a live worktree in the configured project");
      }
      const bindings = this.store.all();
      if (bindings.some((row) => row.key !== key && row.key.split(":")[1] === String(issue.id))) {
        throw new Error("Issue is already bound in another repository; explicit migration is required");
      }
      const current = bindings.find((row) => row.key === key);
      if (current?.agentId && current.agentId !== agentId) throw new Error("Cannot replace an existing issue-session binding");
      const row: Binding = current ?? {
        key, repository: config.repository, number: issue.number, dispatchId: randomUUID(),
        branch: workspace.slug, phase: "active", diagnostic: "",
      };
      row.agentId = agent.id;
      row.workspaceId = agent.workspaceId;
      row.branch = workspace.slug;
      this.assertLiveBinding(row, agent);
      row.phase = "active";
      // Adoption acknowledges the latest snapshot; it does not inject a new turn.
      row.deliveredRevision = revision(issue, await this.tracker.blockers(config.repository, issue),
        config.mapIssue ? (await this.tracker.issue(config.repository, config.mapIssue)).body ?? "" : "");
      delete row.pendingDelivery;
      this.save(row, "adopted: existing session retained");
    });
  }
}
