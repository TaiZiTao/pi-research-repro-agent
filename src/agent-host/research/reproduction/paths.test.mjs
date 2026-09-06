import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureReproductionDirs, reproductionPaths } from "./paths.ts";

function tempWorkspace(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-reproduction-paths-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("derives reproduction paths below the project workspace", (t) => {
  const workspace = tempWorkspace(t);

  const paths = reproductionPaths(workspace);
  const root = path.join(workspace, "reproduction");

  assert.deepEqual(paths, {
    root,
    workspace: path.join(root, "workspace"),
    artifactsRoot: path.join(root, "artifacts"),
    stateFile: path.join(root, "reproduction-plan.json"),
  });
  for (const derived of [paths.workspace, paths.artifactsRoot, paths.stateFile]) {
    const relative = path.relative(paths.root, derived);
    assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), relative);
  }
});

test("rejects relative and traversal-shaped project workspaces", (t) => {
  tempWorkspace(t);
  for (const input of [
    "workspace",
    "./workspace",
    "../escape",
    "sub/../../outside",
    "..\\outside",
    "C:drive-relative",
  ]) {
    assert.throws(() => reproductionPaths(input), /absolute/, input);
  }
});

test("an absolute workspace with traversal segments resolves safely inside itself", (t) => {
  const workspace = tempWorkspace(t);
  const input = path.join(workspace, "projects", "..", "nested", "deep");

  const paths = reproductionPaths(input);

  assert.equal(paths.root, path.resolve(input, "reproduction"));
  assert.equal(path.relative(paths.root, paths.stateFile), "reproduction-plan.json");
  assert.ok(paths.root.startsWith(path.resolve(workspace) + path.sep));
});

test("ensureReproductionDirs creates the directories and is idempotent", async (t) => {
  const workspace = tempWorkspace(t);
  const paths = reproductionPaths(workspace);

  await ensureReproductionDirs(paths);
  await ensureReproductionDirs(paths);

  for (const directory of [paths.root, paths.workspace, paths.artifactsRoot]) {
    assert.equal(existsSync(directory), true, directory);
    assert.equal(statSync(directory).isDirectory(), true, directory);
  }
  assert.equal(existsSync(paths.stateFile), false);
});

test("reproductionPaths rejects a non-string or empty workspace path", () => {
  assert.throws(() => reproductionPaths(""), /absolute/);
});
