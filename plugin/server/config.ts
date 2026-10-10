import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export const INTERVAL_MS = 5 * 60 * 1000;
export const configSchema = z.object({
  enabled: z.boolean().default(false),
  daemonUrl: z.string().url().refine((value) => /^wss?:\/\//.test(value)),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  cwd: z.string().refine(isAbsolute, "cwd must be absolute"),
  mapIssue: z.number().int().positive().nullable().default(null),
  claimOwner: z.string().regex(/^[a-zA-Z0-9-]+$/),
  provider: z.string().regex(/^[^/\s]+\/\S+$/, "Use an explicit provider/model"),
  prefix: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).default("wayfinder"),
  baseBranch: z.string().min(1).default("main"),
  maxActiveAgents: z.number().int().min(1).max(100),
  skillDirectories: z.array(z.string().refine(isAbsolute)).default([
    join(homedir(), ".agents", "skills"), join(homedir(), ".copilot", "skills"),
  ]),
}).strict();
export type Config = z.infer<typeof configSchema>;

export function stateDirectory(): string {
  return join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "wayfinder");
}

export async function readConfig(directory = stateDirectory()): Promise<Config> {
  return configSchema.parse(JSON.parse(await readFile(join(directory, "config.json"), "utf8")));
}
