import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { RESEARCH_SKILLS, enabledResearchSkills } from "./skills.ts";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const skillNames = ["paper_analysis", "reproduction_planning", "reproduction_execution"];

test("research Skills expose the phase-one contract in dependency order", () => {
  assert.deepEqual(
    RESEARCH_SKILLS.map((skill) => skill.name),
    skillNames,
  );
  assert.deepEqual(enabledResearchSkills("ready"), ["paper_analysis"]);
});

test("research Skills remain disabled before readiness and in terminal failure states", () => {
  for (const status of ["created", "acquiring", "ingesting", "failed", "cancelled"]) {
    assert.deepEqual(enabledResearchSkills(status), [], status);
  }
});

test("research Skill resources declare exact names and reserve evidence search for paper analysis", async () => {
  const contents = await Promise.all(
    skillNames.map((name) => readFile(path.join(root, "resources", "research-skills", name, "SKILL.md"), "utf8")),
  );

  for (const [index, content] of contents.entries()) {
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    assert.ok(frontmatter, `${skillNames[index]} has YAML frontmatter`);
    assert.equal(parse(frontmatter[1]).name, skillNames[index]);
  }

  assert.equal(contents[0].includes("`research_search_evidence`"), true);
  assert.equal(contents[1].includes("research_search_evidence"), false);
  assert.equal(contents[2].includes("research_search_evidence"), false);
});

test("electron-builder packages only research Skill markdown resources", async () => {
  const config = parse(await readFile(path.join(root, "electron-builder.yml"), "utf8"));
  const fileSet = config.extraResources.find(
    (entry) => entry.from === "resources/research-skills" && entry.to === "research/skills",
  );

  assert.deepEqual(fileSet?.filter, ["**/SKILL.md"]);
});
