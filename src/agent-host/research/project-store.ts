import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
// Bundling keeps node:sqlite resolvable at runtime: esbuild would otherwise
// strip the node: prefix and Node only resolves sqlite under node:sqlite.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:" + "sqlite") as typeof import("node:sqlite");
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { ResearchProject } from "../../shared/research/types.ts";

interface ProjectRow {
  payload_json: string;
}

export class ResearchProjectStore {
  readonly #database: DatabaseSyncType;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS research_projects (
        project_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  put(project: ResearchProject): void {
    this.#database
      .prepare(
        `
        INSERT INTO research_projects (project_id, payload_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `,
      )
      .run(project.projectId, JSON.stringify(project), project.updatedAt);
  }

  get(projectId: string): ResearchProject | undefined {
    const row = this.#database
      .prepare("SELECT payload_json FROM research_projects WHERE project_id = ?")
      .get(projectId) as ProjectRow | undefined;
    return row === undefined ? undefined : (JSON.parse(row.payload_json) as ResearchProject);
  }

  list(): ResearchProject[] {
    const rows = this.#database
      .prepare("SELECT payload_json FROM research_projects ORDER BY updated_at DESC")
      .all() as unknown as ProjectRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as ResearchProject);
  }

  close(): void {
    this.#database.close();
  }
}
