import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
export const issueSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  html_url: z.string().url(),
  repository_url: z.string().url(),
  labels: z.array(z.object({ name: z.string() })),
  assignees: z.array(z.object({ login: z.string() })),
  pull_request: z.unknown().optional(),
});
export type Issue = z.infer<typeof issueSchema>;
export type Blocker = { repository: string; number: number; state: "open" | "closed" };

export interface Tracker {
  repositoryId(repository: string): Promise<number>;
  issue(repository: string, number: number): Promise<Issue>;
  candidates(repository: string, mapIssue: number | null): Promise<Issue[]>;
  blockers(repository: string, issue: Issue): Promise<Blocker[]>;
  claim(repository: string, number: number, owner: string): Promise<void>;
}

export function issueRepository(issue: Issue): string {
  const match = /^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)$/.exec(issue.repository_url);
  if (!match) throw new Error("Unsupported or ambiguous issue repository");
  return match[1];
}

export function fallbackBlockers(body: string, repository: string): Omit<Blocker, "state">[] {
  const result: Omit<Blocker, "state">[] = [];
  for (const original of body.split("\n")) {
    const line = original.replace(/\*\*/g, "").replace(/^\s*[-*]\s+/, "").trim();
    if (!/\bblocked[\s_-]*by\b/i.test(line)) continue;
    const match = /^blocked[\s_-]*by:\s*(.+)$/i.exec(line);
    if (!match) throw new Error(`Ambiguous blocker line: ${original}`);
    if (/^(none|n\/a)$/i.test(match[1])) continue;
    const refs = match[1].split(/\s*,\s*|\s+/).filter(Boolean);
    for (const ref of refs) {
      const local = /^#([1-9]\d*)$/.exec(ref);
      const qualified = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(ref);
      const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)$/.exec(ref);
      const remote = qualified ?? url;
      if (local) result.push({ repository, number: Number(local[1]) });
      else if (remote) result.push({ repository: remote[1], number: Number(remote[2]) });
      else throw new Error(`Ambiguous blocker reference: ${ref}`);
    }
  }
  return result;
}

export type GhRequest = (path: string, options?: { paginate?: boolean; body?: unknown }) => Promise<unknown>;

export function parseGhOutput(stdout: string, paginate = false): unknown {
  if (!paginate) return JSON.parse(stdout);
  if (!stdout.trim()) throw new Error("GitHub pagination returned no JSON");
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const ghRequest: GhRequest = async (path, options = {}) => {
  const args = ["api", "--hostname", "github.com", path,
    "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"];
  if (options.paginate) args.push("--paginate", "--jq", "tojson");
  if (options.body) {
    args.push("--method", "POST");
    const body = z.object({ assignees: z.array(z.string()) }).parse(options.body);
    for (const assignee of body.assignees) args.push("-f", `assignees[]=${assignee}`);
  }
  const { stdout } = await exec("gh", args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return parseGhOutput(stdout, options.paginate);
};

export class GitHub implements Tracker {
  constructor(private readonly request: GhRequest = ghRequest) {}

  async repositoryId(repository: string): Promise<number> {
    return z.object({ id: z.number().int().positive() }).parse(await this.request(`repos/${repository}`)).id;
  }

  async issue(repository: string, number: number): Promise<Issue> {
    const issue = issueSchema.parse(await this.request(`repos/${repository}/issues/${number}`));
    if (issueRepository(issue).toLowerCase() !== repository.toLowerCase() || issue.number !== number) {
      throw new Error("Issue moved or transferred; explicit reconciliation required");
    }
    return issue;
  }

  private async pages(path: string): Promise<Issue[]> {
    return z.array(z.array(issueSchema)).parse(await this.request(path, { paginate: true })).flat();
  }

  async candidates(repository: string, mapIssue: number | null): Promise<Issue[]> {
    const issues = await this.pages(mapIssue === null
      ? `repos/${repository}/issues?state=open&per_page=100`
      : `repos/${repository}/issues/${mapIssue}/sub_issues?per_page=100`);
    return issues.filter((issue) => issue.state === "open" && !issue.pull_request);
  }

  async blockers(repository: string, issue: Issue): Promise<Blocker[]> {
    const native = await this.pages(
      `repos/${repository}/issues/${issue.number}/dependencies/blocked_by?per_page=100`);
    const blockers = new Map<string, Blocker>();
    for (const blocker of native) {
      const repo = issueRepository(blocker);
      blockers.set(`${repo}#${blocker.number}`, { repository: repo, number: blocker.number, state: blocker.state });
    }
    for (const ref of fallbackBlockers(issue.body ?? "", repository)) {
      const blocker = await this.issue(ref.repository, ref.number);
      blockers.set(`${ref.repository}#${ref.number}`, { ...ref, state: blocker.state });
    }
    return [...blockers.values()].sort((a, b) =>
      `${a.repository}#${a.number}`.localeCompare(`${b.repository}#${b.number}`));
  }

  async claim(repository: string, number: number, owner: string): Promise<void> {
    await this.request(`repos/${repository}/issues/${number}/assignees`, { body: { assignees: [owner] } });
  }
}
