export type ResearchProjectStatus = "created" | "acquiring" | "ingesting" | "ready" | "failed" | "cancelled";

export type ResearchSkillName = "paper_analysis" | "reproduction_planning" | "reproduction_execution";

export interface ResearchProject {
  projectId: string;
  title: string;
  status: ResearchProjectStatus;
  workspacePath: string;
  sourcePdfName: string;
  managedPdfPath: string;
  sha256: string;
  pageCount: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaperChunk {
  paperId: string;
  chunkId: string;
  page: number;
  text: string;
}

export interface EvidenceHit extends PaperChunk {
  score: number;
}

export interface ResearchSkillState {
  name: ResearchSkillName;
  enabled: boolean;
  reason: string;
}

export interface IngestionProgress {
  projectId: string;
  runId: string;
  sequence: number;
  stage: "copying" | "parsing" | "indexing" | "complete" | "failed";
  message: string;
}

export interface ResearchProjectChanged {
  projectId: string;
  runId: string;
  sequence: number;
  project: ResearchProject;
}
