import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
// Bundling keeps node:sqlite resolvable at runtime: esbuild would otherwise
// strip the node: prefix and Node only resolves sqlite under node:sqlite.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:" + "sqlite") as typeof import("node:sqlite");
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { ReproductionPlan } from "./types.ts";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PlanRow {
  payload_json: string;
}

export interface ReproductionStoreOptions {
  /** Invoked after every put with the previous plan (undefined on insert). */
  onPut?: (previous: ReproductionPlan | undefined, next: ReproductionPlan) => void;
}

/**
 * SQLite-backed store for reproduction plans, mirroring ResearchProjectStore.
 *
 * Opens its own connection to the shared research SQLite file; WAL journaling
 * allows several connections to the same database file concurrently.
 */
export class ReproductionStore {
  readonly #database: DatabaseSyncType;
  readonly #options: ReproductionStoreOptions;

  constructor(databasePath: string, options: ReproductionStoreOptions = {}) {
    this.#options = options;
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS reproduction_plans (
        project_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  put(plan: ReproductionPlan): void {
    if (!UUID_V4_PATTERN.test(plan.projectId)) {
      throw new Error("Reproduction plan ID must be an RFC-4122 version-4 UUID");
    }
    const previous = this.get(plan.projectId);
    this.#database
      .prepare(
        `
        INSERT INTO reproduction_plans (project_id, payload_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `,
      )
      .run(plan.projectId, JSON.stringify(plan), plan.updatedAt);
    this.#options.onPut?.(previous, plan);
  }

  get(projectId: string): ReproductionPlan | undefined {
    const row = this.#database
      .prepare("SELECT payload_json FROM reproduction_plans WHERE project_id = ?")
      .get(projectId) as PlanRow | undefined;
    return row === undefined ? undefined : (JSON.parse(row.payload_json) as ReproductionPlan);
  }

  list(): ReproductionPlan[] {
    const rows = this.#database
      .prepare("SELECT payload_json FROM reproduction_plans ORDER BY updated_at DESC")
      .all() as unknown as PlanRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as ReproductionPlan);
  }

  close(): void {
    this.#database.close();
  }
}
