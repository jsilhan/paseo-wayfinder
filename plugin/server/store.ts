import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bindingSchema, type Binding } from "../shared/models";
import { z } from "zod";

export class Store {
  private readonly db: DatabaseSync;
  private readonly lock: DatabaseSync;
  private locked = false;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "bindings.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS bindings (
        key TEXT PRIMARY KEY, agent_id TEXT UNIQUE, workspace_id TEXT UNIQUE, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    // A separate SQLite write lock survives awaits without rolling back durable transitions.
    this.lock = new DatabaseSync(join(directory, "dispatcher-lock.sqlite"));
    this.lock.exec("CREATE TABLE IF NOT EXISTS mutex (id INTEGER PRIMARY KEY)");
  }

  async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.locked) throw new Error("Another reconciliation is already running");
    this.lock.exec("BEGIN IMMEDIATE");
    this.locked = true;
    try {
      return await run();
    } finally {
      this.lock.exec("ROLLBACK");
      this.locked = false;
    }
  }

  all(): Binding[] {
    return this.db.prepare("SELECT data FROM bindings ORDER BY key").all().map((row) =>
      bindingSchema.parse(JSON.parse(z.string().parse(row.data))));
  }

  bindHost(url: string): void {
    const existing = this.db.prepare("SELECT value FROM metadata WHERE key='daemon'").get();
    if (existing && existing.value !== url) {
      throw new Error("State belongs to another daemon URL; do not reuse issue bindings across hosts");
    }
    this.db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('daemon', ?)").run(url);
  }

  bindProject(repositoryId: number, cwd: string, mapIssue: number | null): void {
    const key = `project:${repositoryId}`;
    const value = JSON.stringify({ cwd, mapIssue });
    const existing = this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key);
    if (existing && existing.value !== value && this.all().some((row) => row.key.startsWith(`${repositoryId}:`))) {
      throw new Error("Existing bindings belong to another checkout/map; explicit migration is required");
    }
    this.db.prepare("INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  save(binding: Binding): void {
    const checked = bindingSchema.parse(binding);
    this.db.prepare(`INSERT INTO bindings(key, agent_id, workspace_id, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET agent_id=excluded.agent_id,
        workspace_id=excluded.workspace_id, data=excluded.data`)
      .run(checked.key, checked.agentId ?? null, checked.workspaceId ?? null, JSON.stringify(checked));
  }

  close(): void {
    this.db.close();
    this.lock.close();
  }
}
