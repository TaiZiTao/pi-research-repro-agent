import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ResearchProjectStore } from "./project-store.ts";
import { ResearchProjectNotFoundError, ResearchProjectService } from "./project-service.ts";

const SOURCE_BYTES = Buffer.from("%PDF-1.7\nservice test bytes must remain unchanged\n", "utf8");
const SKILL_CONTENT = "---\nname: paper_analysis\n---\nUse evidence.\n";

function fixture(t, runParser) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-project-service-"));
  const researchRoot = path.join(root, "research");
  const skillsSourceRoot = path.join(root, "skills");
  const sourcePath = path.join(root, "Original Paper.pdf");
  writeFileSync(sourcePath, SOURCE_BYTES);
  for (const skill of ["paper_analysis", "reproduction_planning", "reproduction_execution"]) {
    const directory = path.join(skillsSourceRoot, skill);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "SKILL.md"), skill === "paper_analysis" ? SKILL_CONTENT : `disabled: ${skill}`);
  }
  const store = new ResearchProjectStore(path.join(root, "database", "research.sqlite"));
  const events = [];
  const service = new ResearchProjectService(store, {
    researchRoot,
    python: "python-bin",
    workerPath: "parse_pdf.py",
    skillsSourceRoot,
    runParser,
    now: () => new Date("2026-09-03T12:34:56.000Z"),
    emit: (event) => events.push(event),
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, researchRoot, sourcePath, store, service, events };
}

async function validParser(_python, _worker, pdf, output) {
  const paperId = createHash("sha256")
    .update(await readFile(pdf))
    .digest("hex");
  await writeFile(
    output,
    JSON.stringify([
      { paperId, chunkId: "p1-c1", page: 1, text: "Introduction and methods" },
      { paperId, chunkId: "p2-c1", page: 2, text: "Validation loss evidence 中文" },
    ]),
    "utf8",
  );
}

test("imports a PDF into ready project artifacts, events, and SQLite", async (t) => {
  const calls = [];
  const context = fixture(t, async (...arguments_) => {
    calls.push(arguments_);
    await validParser(...arguments_);
  });

  const project = await context.service.importPdf({
    sourcePath: context.sourcePath,
    title: "  A bounded paper title  ",
  });

  assert.equal(project.status, "ready");
  assert.equal(project.title, "A bounded paper title");
  assert.equal(project.pageCount, 2);
  assert.equal(project.sha256, createHash("sha256").update(SOURCE_BYTES).digest("hex"));
  assert.deepEqual(readFileSync(context.sourcePath), SOURCE_BYTES);
  assert.deepEqual(readFileSync(project.managedPdfPath), SOURCE_BYTES);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ["python-bin", "parse_pdf.py", project.managedPdfPath]);

  const projectRoot = project.workspacePath;
  const chunks = JSON.parse(readFileSync(path.join(projectRoot, "evidence", "chunks.json"), "utf8"));
  assert.equal(chunks.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(path.join(projectRoot, "research-project.json"), "utf8")), project);
  assert.equal(
    readFileSync(path.join(projectRoot, ".pi", "skills", "paper_analysis", "SKILL.md"), "utf8"),
    SKILL_CONTENT,
  );
  assert.equal(existsSync(path.join(projectRoot, ".pi", "skills", "reproduction_planning")), false);
  assert.equal(existsSync(path.join(projectRoot, ".pi", "skills", "reproduction_execution")), false);
  assert.deepEqual(context.store.get(project.projectId), project);
  assert.deepEqual(context.service.listProjects(), [project]);
  assert.deepEqual(
    context.events.map(({ sequence, stage }) => ({ sequence, stage })),
    [
      { sequence: 1, stage: "copying" },
      { sequence: 2, stage: "parsing" },
      { sequence: 3, stage: "indexing" },
      { sequence: 4, stage: "complete" },
    ],
  );
  assert.equal(new Set(context.events.map((event) => event.runId)).size, 1);
});

test("derives and bounds a fallback title from the source filename", async (t) => {
  const context = fixture(t, validParser);

  const project = await context.service.importPdf({ sourcePath: context.sourcePath, title: "   " });

  assert.equal(project.title, "Original Paper");
  assert.ok(project.title.length <= 200);
});

test("workspace lookup uses resolved exact equality rather than prefixes", async (t) => {
  const context = fixture(t, validParser);
  const project = await context.service.importPdf({ sourcePath: context.sourcePath });

  assert.equal(context.service.findByWorkspace(path.join(project.workspacePath, "."))?.projectId, project.projectId);
  assert.equal(context.service.findByWorkspace(project.workspacePath.toUpperCase())?.projectId, project.projectId);
  assert.equal(context.service.findByWorkspace(path.join(project.workspacePath, "child")), undefined);
});

test("parser failures persist a failed project without final chunks or source changes", async (t) => {
  const context = fixture(t, async () => {
    throw new Error(`parser failed at ${context.sourcePath}`);
  });

  const project = await context.service.importPdf({ sourcePath: context.sourcePath });

  assert.equal(project.status, "failed");
  assert.equal(project.pageCount, null);
  assert.ok(project.error);
  assert.ok(project.error.length <= 500);
  assert.equal(project.error.includes(context.sourcePath), false);
  assert.deepEqual(readFileSync(context.sourcePath), SOURCE_BYTES);
  assert.equal(existsSync(path.join(project.workspacePath, "evidence", "chunks.json")), false);
  assert.equal(
    readdirSync(path.join(project.workspacePath, "evidence")).some((name) => name.endsWith(".tmp")),
    false,
  );
  assert.deepEqual(context.store.get(project.projectId), project);
  assert.equal(context.events.at(-1).stage, "failed");
  assert.equal(context.events.at(-1).sequence, 3);
});

test("invalid parser JSON is rejected and converted to project failure", async (t) => {
  const context = fixture(t, async (_python, _worker, _pdf, output) => {
    await writeFile(output, JSON.stringify([{ paperId: "wrong", chunkId: "", page: 0, text: "" }]), "utf8");
  });

  const project = await context.service.importPdf({ sourcePath: context.sourcePath });

  assert.equal(project.status, "failed");
  assert.match(project.error, /invalid parser output/i);
  assert.equal(existsSync(path.join(project.workspacePath, "evidence", "chunks.json")), false);
});

test("evidence search requires an existing ready project", async (t) => {
  const context = fixture(t, validParser);
  const ready = await context.service.importPdf({ sourcePath: context.sourcePath });

  assert.equal(context.service.searchEvidence(ready.projectId, "loss")[0].page, 2);
  assert.throws(
    () => context.service.getProject("123e4567-e89b-42d3-a456-426614174000"),
    (error) => error instanceof ResearchProjectNotFoundError && error.name === "ResearchProjectNotFoundError",
  );

  const failedContext = fixture(t, async () => {
    throw new Error("parser unavailable");
  });
  const failed = await failedContext.service.importPdf({ sourcePath: failedContext.sourcePath });
  assert.throws(() => failedContext.service.searchEvidence(failed.projectId, "loss"), /ready/i);
  assert.throws(
    () => context.service.searchEvidence("223e4567-e89b-42d3-a456-426614174000", "loss"),
    ResearchProjectNotFoundError,
  );
});
