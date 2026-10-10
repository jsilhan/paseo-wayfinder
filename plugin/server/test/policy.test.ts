import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../config";
import { checkSkills, workerPrompt } from "../policy";
import { issueSchema } from "../github";
import type { Binding } from "../../shared/models";

test("concrete skills suffice without installing the Wayfinder coordinator skill", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "wayfinder-skills-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const config = configSchema.parse({
    daemonUrl: "ws://paseo.test.invalid/ws", repository: "owner/repo", cwd: directory,
    claimOwner: "human", provider: "copilot/model", maxActiveAgents: 1,
    skillDirectories: [directory],
  });
  await checkSkills(config, "task");
  for (const type of ["research", "prototype", "grilling"] as const) {
    await assert.rejects(checkSkills(config, type), /blocked-skill/);
    mkdirSync(join(directory, type));
    writeFileSync(join(directory, type, "SKILL.md"), "# Test skill");
  }
  await checkSkills(config, "research");
  await checkSkills(config, "prototype");
  await assert.rejects(checkSkills(config, "grilling"), /domain-modeling/);
  mkdirSync(join(directory, "domain-modeling"));
  writeFileSync(join(directory, "domain-modeling", "SKILL.md"), "# Test skill");
  await checkSkills(config, "grilling");
});

test("task prompt follows the stated prerequisite without reinvoking the coordinator", () => {
  const config = configSchema.parse({
    daemonUrl: "ws://paseo.test.invalid/ws", repository: "owner/repo", cwd: "/project",
    claimOwner: "human", provider: "copilot/model", maxActiveAgents: 1,
  });
  const issue = issueSchema.parse({
    id: 10, number: 42, title: "Provision access", body: "Ask the operator to provision read-only access.",
    state: "open", html_url: "https://github.com/owner/repo/issues/42",
    repository_url: "https://api.github.com/repos/owner/repo",
    labels: [{ name: "wayfinder:task" }], assignees: [{ login: "human" }],
  });
  const binding: Binding = {
    key: "1:10", repository: "owner/repo", number: 42, dispatchId: "dispatch",
    branch: "wayfinder-42", phase: "active", diagnostic: "",
  };
  const prompt = workerPrompt(config, binding, issue, [], "", false);
  assert.match(prompt, /already selected and claimed/);
  assert.match(prompt, /Do not invoke \/wayfinder/);
  assert.match(prompt, /not a \/task skill/);
  assert.match(prompt, /Ask the operator to provision read-only access/);
});
