import { z } from "zod";

export const bindingSchema = z.object({
  key: z.string().regex(/^[1-9]\d*:[1-9]\d*$/),
  repository: z.string(),
  number: z.number().int(),
  dispatchId: z.string(),
  branch: z.string(),
  phase: z.enum(["reserved", "claiming", "claimed", "workspace-pending", "workspace",
    "agent-pending", "active"]),
  workspaceId: z.string().optional(),
  agentId: z.string().optional(),
  deliveredRevision: z.string().optional(),
  pendingDelivery: z.string().optional(),
  diagnostic: z.string(),
});
export type Binding = z.infer<typeof bindingSchema>;
