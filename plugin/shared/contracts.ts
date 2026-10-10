import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { bindingSchema } from "./models";
export type { Binding } from "./models";

export const statusSchema = z.object({
  enabled: z.boolean(),
  intervalMs: z.number(),
  lastTick: z.string().nullable(),
  error: z.string().nullable(),
  bindings: z.array(bindingSchema),
  diagnostics: z.array(z.string()),
});
export const statusRpc = defineRpc({
  name: "wayfinder.status",
  input: z.object({}),
  output: statusSchema,
});
export const tickRpc = defineRpc({
  name: "wayfinder.tick",
  input: z.object({}),
  output: statusSchema,
});
export const adoptRpc = defineRpc({
  name: "wayfinder.adopt",
  input: z.object({ issueNumber: z.number().int().positive(), agentId: z.string().min(1) }),
  output: statusSchema,
});
