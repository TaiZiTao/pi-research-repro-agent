import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveResearchRuntimePaths } from "./runtime-paths.ts";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-research-runtime-"));
  const userData = path.join(root, "user-data");
  const appRoot = path.join(root, "app");
  const resources = path.join(root, "resources");
  const python = path.join(root, process.platform === "win32" ? "python.exe" : "python");
  mkdirSync(userData, { recursive: true });
  mkdirSync(path.join(appRoot, "python", "paper_worker"), { recursive: true });
  mkdirSync(path.join(appRoot, "resources", "research-skills"), { recursive: true });
  mkdirSync(path.join(resources, "research", "python"), { recursive: true });
  mkdirSync(path.join(resources, "research", "skills"), { recursive: true });
  writeFileSync(path.join(appRoot, "python", "paper_worker", "parse_pdf.py"), "# dev worker\n");
  writeFileSync(path.join(resources, "research", "python", "parse_pdf.py"), "# packaged worker\n");
  writeFileSync(python, "python placeholder\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, userData, appRoot, resources, python };
}

test("resolves and verifies development research paths", (t) => {
  const f = fixture(t);
  const paths = resolveResearchRuntimePaths({
    PI_DESKTOP_USER_DATA: f.userData,
    PI_DESKTOP_APP_ROOT: f.appRoot,
    PI_DESKTOP_RESOURCES: f.resources,
    PI_DESKTOP_PACKAGED: "0",
    RESEARCH_PYTHON: f.python,
  });

  assert.deepEqual(paths, {
    researchRoot: path.join(f.userData, "research"),
    databasePath: path.join(f.userData, "research", "research.sqlite"),
    python: f.python,
    workerPath: path.join(f.appRoot, "python", "paper_worker", "parse_pdf.py"),
    skillsSourceRoot: path.join(f.appRoot, "resources", "research-skills"),
  });
});

test("resolves packaged paths and requires an explicit Python executable", (t) => {
  const f = fixture(t);
  const paths = resolveResearchRuntimePaths({
    PI_DESKTOP_USER_DATA: f.userData,
    PI_DESKTOP_APP_ROOT: f.appRoot,
    PI_DESKTOP_RESOURCES: f.resources,
    PI_DESKTOP_PACKAGED: "1",
    RESEARCH_PYTHON: f.python,
  });

  assert.equal(paths.workerPath, path.join(f.resources, "research", "python", "parse_pdf.py"));
  assert.equal(paths.skillsSourceRoot, path.join(f.resources, "research", "skills"));
  assert.throws(
    () =>
      resolveResearchRuntimePaths({
        PI_DESKTOP_USER_DATA: f.userData,
        PI_DESKTOP_APP_ROOT: f.appRoot,
        PI_DESKTOP_RESOURCES: f.resources,
        PI_DESKTOP_PACKAGED: "1",
      }),
    /RESEARCH_PYTHON/,
  );
});

test("rejects missing, relative, and nonexistent runtime inputs with bounded errors", (t) => {
  const f = fixture(t);
  const valid = {
    PI_DESKTOP_USER_DATA: f.userData,
    PI_DESKTOP_APP_ROOT: f.appRoot,
    PI_DESKTOP_RESOURCES: f.resources,
    PI_DESKTOP_PACKAGED: "0",
    RESEARCH_PYTHON: f.python,
  };

  for (const env of [
    { ...valid, PI_DESKTOP_USER_DATA: undefined },
    { ...valid, PI_DESKTOP_APP_ROOT: "relative/app" },
    { ...valid, PI_DESKTOP_RESOURCES: "relative/resources" },
    { ...valid, RESEARCH_PYTHON: path.join(f.root, "missing-python") },
  ]) {
    assert.throws(
      () => resolveResearchRuntimePaths(env),
      (error) => error instanceof Error && error.message.length <= 160 && !error.message.includes(f.root),
    );
  }
});
