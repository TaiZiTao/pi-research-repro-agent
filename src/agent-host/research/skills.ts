import type { ResearchProjectStatus, ResearchSkillName } from "../../shared/research/types.ts";

export const RESEARCH_SKILLS: ReadonlyArray<{ name: ResearchSkillName; enabledInPhaseOne: boolean }> = [
  { name: "paper_analysis", enabledInPhaseOne: true },
  { name: "reproduction_planning", enabledInPhaseOne: false },
  { name: "reproduction_execution", enabledInPhaseOne: false },
];

export function enabledResearchSkills(status: ResearchProjectStatus): ResearchSkillName[] {
  if (status !== "ready") return [];
  return RESEARCH_SKILLS.filter((skill) => skill.enabledInPhaseOne).map((skill) => skill.name);
}
