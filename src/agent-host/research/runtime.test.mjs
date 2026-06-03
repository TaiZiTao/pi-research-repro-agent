import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  closeResearchRuntime,
  getResearchProjectService,
  initializeResearchRuntime,
  peekResearchProjectService,
} from "./runtime.ts";

test("research runtime initializes lazily as one shared service and resets cleanly", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-research-runtime-lifecycle-"));
  const appRoot = path.join(root, "app");
  const resources = path.join(root, "resources");
  const python = path.join(root, process.platform === "win32" ? "python.exe" : "python");
  mkdirSync(path.join(appRoot, "python", "paper_worker"), { recursive: true });
  mkdirSync(path.join(appRoot, "resources", "research-skills"), { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(path.join(appRoot, "python", "paper_worker", "parse_pdf.py"), "# worker\n");
  writeFileSync(python, "python placeholder\n");
  t.after(() => {
    closeResearchRuntime();
    rmSync(root, { recursive: true, force: true });
  });

  assert.equal(peekResearchProjectService(), undefined);
  const first = initializeResearchRuntime({
    env: {
      PI_DESKTOP_USER_DATA: path.join(root, "user-data"),
      PI_DESKTOP_APP_ROOT: appRoot,
      PI_DESKTOP_RESOURCES: resources,
      PI_DESKTOP_PACKAGED: "0",
      RESEARCH_PYTHON: python,
    },
  });
  const second = initializeResearchRuntime({ env: {} });

  assert.equal(second, first);
  assert.equal(getResearchProjectService(), first);
  closeResearchRuntime();
  assert.equal(peekResearchProjectService(), undefined);
  assert.throws(() => getResearchProjectService(), /unavailable/i);
});
