import type { PaseoApi } from "@getpaseo/client";
import type { Config } from "./config";
import type { Binding } from "../shared/models";

export type Agent = {
  id: string;
  workspaceId?: string;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  archived: boolean;
  labels: Record<string, string>;
};
export type Workspace = { id: string; cwd: string; slug?: string; archiving: boolean };
export interface Sessions {
  agents(): Promise<Agent[]>;
  workspaces(): Promise<Workspace[]>;
  createWorkspace(config: Config, row: Binding): Promise<string>;
  createAgent(config: Config, row: Binding): Promise<string>;
  send(agentId: string, prompt: string, messageId: string): Promise<void>;
}

export class PaseoSessions implements Sessions {
  constructor(private readonly paseo: PaseoApi) {}

  async agents(): Promise<Agent[]> {
    const agents: Agent[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.paseo.agents.list({
        filter: { includeArchived: true }, page: { limit: 100, cursor },
      });
      agents.push(...page.entries.map(({ agent }) => ({
        id: agent.id, workspaceId: agent.workspaceId, status: agent.status,
        archived: Boolean(agent.archivedAt), labels: agent.labels,
      })));
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return agents;
  }

  async workspaces(): Promise<Workspace[]> {
    const workspaces: Workspace[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.paseo.workspaces.list({ page: { limit: 100, cursor } });
      workspaces.push(...page.entries.map((workspace) => ({
        id: workspace.id, cwd: workspace.projectRootPath,
        slug: workspace.worktreeSlug, archiving: Boolean(workspace.archivingAt),
      })));
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return workspaces;
  }

  async createWorkspace(config: Config, row: Binding): Promise<string> {
    const workspace = await this.paseo.workspaces.create({
      title: `${row.branch} (${config.repository}#${row.number})`,
      source: {
        kind: "worktree", cwd: config.cwd, action: "branch-off",
        branchName: row.branch, worktreeSlug: row.branch, baseBranch: config.baseBranch,
      },
    });
    return workspace.id;
  }

  async createAgent(config: Config, row: Binding): Promise<string> {
    if (!row.workspaceId) throw new Error("Cannot create an agent without its own workspace");
    const agent = await this.paseo.workspaces.ref(row.workspaceId).agents.create({
      config: { provider: config.provider },
      title: `${config.repository}#${row.number}`,
      autoArchive: false,
      labels: { "wayfinder.issue": row.key, "wayfinder.dispatch": row.dispatchId },
    });
    return agent.id;
  }

  async send(agentId: string, prompt: string, messageId: string): Promise<void> {
    const agent = this.paseo.agents.ref(agentId);
    await agent.refresh();
    if (agent.status !== "idle") throw new Error("Agent is no longer idle; update was not sent");
    await agent.send(prompt, { messageId });
  }
}
