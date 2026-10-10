import { createPaseoClient } from "@getpaseo/client";
import { INTERVAL_MS, readConfig, stateDirectory } from "./config";
import { Dispatcher, message } from "./dispatcher";
import { GitHub } from "./github";
import { PaseoSessions } from "./paseo";
import { Store } from "./store";

export class Runtime {
  private readonly store = new Store(stateDirectory());
  private enabled = false;
  private lastTick: string | null = null;
  private error: string | null = null;
  private diagnostics: string[] = [];
  private pending: Promise<void> | null = null;
  private stopped = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor() {
    this.timer = setInterval(() => { void this.run(); }, INTERVAL_MS);
    void this.run();
  }

  status() {
    return {
      enabled: this.enabled, intervalMs: INTERVAL_MS, lastTick: this.lastTick,
      error: this.error, bindings: this.store.all(), diagnostics: this.diagnostics,
    };
  }

  async run(adoption?: { issueNumber: number; agentId: string }): Promise<void> {
    if (this.stopped) throw new Error("Plugin is stopping");
    if (this.pending) {
      if (adoption) throw new Error("Reconciliation is in progress; retry adoption after it finishes");
      return this.pending;
    }
    this.pending = this.execute(adoption);
    try { await this.pending; } finally { this.pending = null; }
  }

  private async execute(adoption?: { issueNumber: number; agentId: string }): Promise<void> {
    try {
      const config = await readConfig();
      this.enabled = config.enabled;
      this.error = null;
      if (!config.enabled && !adoption) return;
      const client = createPaseoClient({
        url: config.daemonUrl, clientId: "paseo-wayfinder-dispatcher",
        password: process.env.PASEO_WAYFINDER_PASSWORD,
        reconnect: { enabled: false }, connectTimeoutMs: 15_000,
      });
      try {
        await client.connect();
        const dispatcher = new Dispatcher(this.store, new GitHub(), new PaseoSessions(client));
        if (adoption) await dispatcher.adopt(config, adoption.issueNumber, adoption.agentId);
        else await dispatcher.tick(config);
        this.diagnostics = dispatcher.diagnostics;
        this.lastTick = new Date().toISOString();
        for (const diagnostic of this.diagnostics) console.log(`[wayfinder] ${diagnostic}`);
      } finally {
        await client.close();
      }
    } catch (error) {
      this.error = message(error);
      console.error(`[wayfinder] ${this.error}`);
      if (adoption) throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    try { await this.pending; } finally { this.store.close(); }
  }
}
