import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectPdfInput, MAX_PDF_BYTES, researchProjectPaths } from "./paths.ts";

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-research-paths-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("a valid UUID project path remains below the configured root", (t) => {
  const root = temporaryDirectory(t);
  const projectId = "123e4567-e89b-42d3-a456-426614174000";

  const paths = researchProjectPaths(root, projectId);
  const projectsRoot = path.resolve(root, "projects");

  assert.deepEqual(paths, {
    projectRoot: path.join(projectsRoot, projectId),
    inputRoot: path.join(projectsRoot, projectId, "input"),
    evidenceRoot: path.join(projectsRoot, projectId, "evidence"),
    managedPdfPath: path.join(projectsRoot, projectId, "input", "paper.pdf"),
    chunksPath: path.join(projectsRoot, projectId, "evidence", "chunks.json"),
    projectFile: path.join(projectsRoot, projectId, "research-project.json"),
    skillsRoot: path.join(projectsRoot, projectId, ".pi", "skills"),
  });
  assert.equal(path.relative(projectsRoot, paths.projectRoot), projectId);
});

test("invalid and traversal-shaped project IDs are rejected", (t) => {
  const root = temporaryDirectory(t);

  for (const projectId of ["123e4567-e89b-12d3-a456-426614174000", "../123e4567-e89b-42d3-a456-426614174000"]) {
    assert.throws(() => researchProjectPaths(root, projectId), /UUID/);
  }
});

test("a .txt file is rejected", (t) => {
  const root = temporaryDirectory(t);
  const input = path.join(root, "paper.txt");
  writeFileSync(input, "%PDF-test");

  assert.throws(() => inspectPdfInput(input), /\.pdf/i);
});

test("a renamed non-PDF with a .pdf extension is rejected by signature", (t) => {
  const root = temporaryDirectory(t);
  const input = path.join(root, "paper.pdf");
  writeFileSync(input, "plain text");

  assert.throws(() => inspectPdfInput(input), /signature/i);
});

test("a small PDF is accepted canonically without changing its bytes", (t) => {
  const root = temporaryDirectory(t);
  const input = path.join(root, "sample.PDF");
  const contents = Buffer.from("%PDF-1.7\nminimal test document\n");
  writeFileSync(input, contents);

  const inspected = inspectPdfInput(input);

  assert.deepEqual(inspected, {
    canonicalPath: realpathSync(input),
    size: contents.length,
    name: "sample.PDF",
  });
  assert.deepEqual(readFileSync(input), contents);
  assert.equal(MAX_PDF_BYTES, 100 * 1024 * 1024);
});
