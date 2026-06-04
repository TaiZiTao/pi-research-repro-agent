import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { call } from "@/lib/api-client";
import {
  mapCandidatesFromResult,
  mapWorkflowStages,
  type CandidateCard,
  type EvidenceRow,
  type WorkflowStage,
} from "./mapping.ts";

interface ProjectRow {
  projectId: string;
  title: string;
  status: string;
  pageCount: number | null;
  error: string | null;
  workspacePath: string;
  createdAt: string;
}
interface ProjectDetail {
  project: ProjectRow & { sourcePdfName: string; sha256: string; updatedAt: string; managedPdfPath?: string };
  reproduction: {
    phase: string;
    title: string;
    agentReproduction: boolean;
    repairRoundsUsed: number;
    repository: unknown;
    steps: Array<{
      id: string;
      title: string;
      kind: string;
      status: string;
      command: string | null;
      exitCode: number | null;
      error: string | null;
      artifactRef: string | null;
      artifactBytes: number | null;
      artifactSha256: string | null;
    }>;
  } | null;
  recentEvents: Array<{ type: string; stage?: string; message: string; createdAt: string }>;
}

interface ResearchPanelProps {
  open: boolean;
  sessionCwd: string | null;
  onClose: () => void;
  onOpenInSession?: (workspacePath: string) => void;
  onOpenPdf?: (pdfPath: string, page?: number) => void;
  researchEvidence?: EvidenceRow[];
  finalizeStatus?: { accepted: boolean; errors: string } | null;
  /** Renders inline inside the app right-panel tab system instead of a fixed overlay. */
  embedded?: boolean;
}

const stageColor: Record<string, string> = {
  pending: "var(--text-dim)",
  running: "var(--accent)",
  succeeded: "#2e9e5b",
  failed: "var(--danger)",
  blocked: "#b58900",
};

function eventDotColor(event: { type: string; stage?: string }): string {
  const state = event.stage ?? event.type;
  if (state === "failed" || state === "blocked") return "var(--danger)";
  if (state === "completed" || state === "succeeded") return "#2e9e5b";
  if (state === "running") return "var(--accent)";
  if (
    state === "copying" ||
    state === "parsing" ||
    state === "indexing" ||
    state === "planned" ||
    state === "preparing" ||
    state === "verifying"
  ) {
    return "#b58900";
  }
  return "var(--text-dim)";
}

function StageBadge({ state }: { state: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        color: stageColor[state] ?? "var(--text-dim)",
        border: "1px solid color-mix(in srgb, " + (stageColor[state] ?? "var(--text-dim)") + " 50%, transparent)",
        borderRadius: 9,
        padding: "0 7px",
        flexShrink: 0,
      }}
    >
      {state}
    </span>
  );
}

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 10px",
          background: "none",
          border: "none",
          color: "var(--text)",
          fontWeight: 600,
          fontSize: 12,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
        <span>{title}</span>
      </button>
      {open && <div style={{ padding: "0 10px 10px", fontSize: 12 }}>{children}</div>}
    </div>
  );
}

export function ResearchPanel({
  open,
  sessionCwd,
  onClose,
  onOpenInSession,
  onOpenPdf,
  researchEvidence,
  finalizeStatus,
  embedded = false,
}: ResearchPanelProps) {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<CandidateCard[] | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const refreshList = useCallback(async () => {
    try {
      const result = await call("research.list");
      setProjects(result.projects);
      setError(null);
      if (result.projects.length > 0 && !projectId) {
        const match = sessionCwd ? result.projects.find((p) => p.workspacePath === sessionCwd) : undefined;
        setProjectId((match ?? result.projects[0]).projectId);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [projectId, sessionCwd]);

  const refreshDetail = useCallback(async (id: string | null) => {
    if (!id) {
      setDetail(null);
      return;
    }
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const result = await call("research.detail", { projectId: id });
      setDetail(result as ProjectDetail);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshList();
  }, [open, refreshList]);

  useEffect(() => {
    if (!open || !projectId) return;
    void refreshDetail(projectId);
    const timer = setInterval(() => void refreshDetail(projectId), 3000);
    return () => clearInterval(timer);
  }, [open, projectId, refreshDetail]);

  const handleImport = useCallback(async () => {
    const pdf = await window.piBridge?.selectPdfFile?.();
    if (!pdf) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await call("research.import", { pdfPath: pdf });
      setNotice("Imported " + result.project.title);
      setProjectId(result.project.projectId);
      await refreshList();
    } catch (importError) {
      setNotice("Import failed: " + (importError instanceof Error ? importError.message : String(importError)));
    } finally {
      setBusy(false);
    }
  }, [refreshList]);

  const handleSearchPapers = useCallback(async () => {
    const query = searchQuery.trim();
    if (!query) return;
    setSearching(true);
    setNotice(null);
    try {
      const result = await call("research.papers.search", { query });
      const cards = mapCandidatesFromResult(JSON.stringify({ candidates: result.candidates }));
      setCandidates(cards);
      if (cards.length === 0) setNotice("没有找到开放论文,换个关键词试试。");
    } catch (searchError) {
      setNotice("搜索失败: " + (searchError instanceof Error ? searchError.message : String(searchError)));
    } finally {
      setSearching(false);
    }
  }, [searchQuery]);

  const handleImportCandidate = useCallback(
    async (card: CandidateCard) => {
      if (!card.pdfUrl || importingId) return;
      setImportingId(card.id);
      setNotice(null);
      try {
        const result = await call("research.papers.import", { pdfUrl: card.pdfUrl, title: card.title });
        setNotice("已下载并导入: " + result.project.title);
        setProjectId(result.project.projectId);
        await refreshList();
      } catch (importError) {
        setNotice("下载/导入失败: " + (importError instanceof Error ? importError.message : String(importError)));
      } finally {
        setImportingId(null);
      }
    },
    [importingId, refreshList],
  );

  if (!open) return null;
  const project = detail?.project ?? null;
  const reproduction = detail?.reproduction ?? null;
  const events = detail?.recentEvents ?? [];
  const stages: WorkflowStage[] = mapWorkflowStages(project, reproduction);
  const status = project?.status ?? null;
  return (
    <div
      role={embedded ? undefined : "dialog"}
      aria-label="Research panel"
      style={
        embedded
          ? {
              display: "flex",
              flexDirection: "column",
              height: "100%",
              overflow: "hidden",
              fontFamily: "var(--font-ui, system-ui)",
              color: "var(--text)",
              background: "var(--bg)",
            }
          : {
              position: "fixed",
              top: 0,
              right: 0,
              bottom: 0,
              width: "min(380px, 38vw)",
              background: "var(--bg-panel, #fff)",
              borderLeft: "1px solid var(--border)",
              boxShadow: "-8px 0 24px rgba(0,0,0,0.08)",
              display: "flex",
              flexDirection: "column",
              zIndex: 900,
              fontFamily: "var(--font-ui, system-ui)",
              color: "var(--text)",
            }
      }
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <strong style={{ flex: 1, fontSize: 13 }}>Research Panel</strong>
        <button
          type="button"
          onClick={() => void handleImport()}
          disabled={busy}
          style={{ padding: "4px 10px", cursor: "pointer", fontSize: 12 }}
        >
          {busy ? "Importing…" : "Import PDF…"}
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          style={{
            padding: "2px 8px",
            cursor: "pointer",
            fontSize: 14,
            background: "none",
            border: "none",
            color: "var(--text-dim)",
          }}
        >
          ×
        </button>
      </div>
      {notice && <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--text-muted)" }}>{notice}</div>}
      {error && <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--danger)" }}>{error}</div>}
      {projects.length > 0 && (
        <div style={{ padding: "6px 12px", fontSize: 12 }}>
          <label style={{ marginRight: 6 }}>Project</label>
          <select
            value={projectId ?? ""}
            onChange={(event) => setProjectId(event.target.value || null)}
            style={{ maxWidth: "78%", fontSize: 12 }}
          >
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.title} · {p.status}
              </option>
            ))}
          </select>
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto" }}>
        <Section title="0 · 在线搜索论文(下载并导入为项目)" defaultOpen={false}>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleSearchPapers();
              }}
              placeholder="搜索 arXiv / OpenAlex 开放论文…"
              style={{ flex: 1, fontSize: 12, padding: "4px 6px", minWidth: 0 }}
            />
            <button
              type="button"
              disabled={searching || !searchQuery.trim()}
              onClick={() => void handleSearchPapers()}
              style={{ padding: "4px 10px", fontSize: 12, cursor: searching ? "default" : "pointer", flexShrink: 0 }}
            >
              {searching ? "搜索中…" : "搜索"}
            </button>
          </div>
          {candidates !== null && candidates.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto" }}>
              {candidates.map((card) => (
                <div key={card.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 11 }}>{card.title}</div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", margin: "2px 0 4px" }}>
                    {card.authors.slice(0, 3).join(", ")}
                    {card.authors.length > 3 ? " et al." : ""} ·{card.year ?? "?"} · {card.source}
                    {card.pdfAvailable ? " · PDF 可用" : " · 无开放 PDF"}
                  </div>
                  <button
                    type="button"
                    disabled={!card.pdfUrl || importingId !== null}
                    onClick={() => void handleImportCandidate(card)}
                    style={{ padding: "2px 8px", fontSize: 11, cursor: "pointer" }}
                  >
                    {importingId === card.id ? "导入中…" : "下载并导入"}
                  </button>
                </div>
              ))}
            </div>
          )}
          {candidates !== null && candidates.length === 0 && (
            <div style={{ color: "var(--text-dim)", fontSize: 11 }}>无结果。换一个关键词试试。</div>
          )}
        </Section>
        {!project && !error && (
          <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>
            No research project. Import a PDF to begin.
          </div>
        )}
        {project && (
          <>
            <Section title="1 · 当前论文">
              <div style={{ display: "grid", gap: 3 }}>
                <Row label="标题" value={project.title} />
                <Row label="页数" value={project.pageCount === null ? "—" : String(project.pageCount)} />
                <Row label="导入状态" value={status ?? "—"} status={status ?? undefined} />
                <Row label="项目ID" value={project.projectId.slice(0, 8) + "…"} />
                <Row label="工作区" value={project.workspacePath} mono />
                <Row label="SHA256" value={project.sha256.slice(0, 12) + "…"} mono />
                {project.error && <Row label="错误" value={project.error} danger />}
                <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                  {onOpenInSession && (
                    <button
                      type="button"
                      onClick={() => onOpenInSession(project.workspacePath)}
                      style={{ padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
                    >
                      在当前会话打开工作区
                    </button>
                  )}
                  {onOpenPdf && project.managedPdfPath && (
                    <button
                      type="button"
                      onClick={() => onOpenPdf(project.managedPdfPath as string)}
                      style={{ padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
                    >
                      打开 PDF
                    </button>
                  )}
                </div>
              </div>
            </Section>
            <Section title="2 · Workflow 进度">
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {stages.map((stage) => (
                  <div key={stage.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        background: stageColor[stage.state] ?? "var(--text-dim)",
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ flex: 1 }}>{stage.label}</span>
                    <StageBadge state={stage.state} />
                  </div>
                ))}
              </div>
            </Section>
            <Section title="3 · 引用与证据">
              {(researchEvidence ?? []).length === 0 && !finalizeStatus && (
                <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
                  在对话中执行 research_search_evidence / research_finalize_answer 后,此处实时显示证据。
                </div>
              )}
              {(researchEvidence ?? []).length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 180, overflowY: "auto" }}>
                  {(researchEvidence ?? []).map((row) => (
                    <div key={row.chunkId} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 4 }}>
                      <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                        {onOpenPdf && project.managedPdfPath ? (
                          <button
                            type="button"
                            onClick={() => onOpenPdf(project.managedPdfPath as string, row.page)}
                            title={`打开 PDF 到第 ${row.page} 页`}
                            style={{
                              background: "none",
                              border: "none",
                              padding: 0,
                              color: "var(--accent)",
                              fontSize: 12,
                              fontWeight: 700,
                              cursor: "pointer",
                            }}
                          >
                            p.{row.page}
                          </button>
                        ) : (
                          <span>p.{row.page}</span>
                        )}
                        <span>· {row.chunkId}</span>
                        <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>score {row.score.toFixed(3)}</span>
                      </div>
                      <div style={{ color: "var(--text-muted)", fontSize: 11, wordBreak: "break-word" }}>
                        {row.text.slice(0, 200)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {finalizeStatus && (
                <div style={{ marginTop: 6, fontSize: 11 }}>
                  <span style={{ color: finalizeStatus.accepted ? "#2e9e5b" : "var(--danger)", fontWeight: 700 }}>
                    {finalizeStatus.accepted ? "引用校验通过" : "引用校验失败"}
                  </span>
                  {finalizeStatus.errors && (
                    <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>{finalizeStatus.errors}</span>
                  )}
                </div>
              )}
            </Section>
            <Section title="4 · 日志与产物" defaultOpen={false}>
              {events.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 700, marginBottom: 4 }}>
                    最近动态
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 150, overflowY: "auto" }}>
                    {events.map((event, index) => (
                      <div
                        key={`${event.createdAt}-${index}`}
                        style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 11 }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 3,
                            background: eventDotColor(event),
                            flexShrink: 0,
                            alignSelf: "center",
                          }}
                        />
                        <span
                          style={{
                            color: "var(--text-dim)",
                            fontFamily: "var(--font-mono)",
                            flexShrink: 0,
                            fontSize: 10,
                          }}
                        >
                          {event.createdAt.slice(11, 19)}
                        </span>
                        <span style={{ color: "var(--text-muted)", wordBreak: "break-word", flex: 1 }}>
                          {event.message}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!reproduction && (
                <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
                  {events.length === 0
                    ? "尚无活动记录。导入 PDF 或让 Agent 调用 research_plan_reproduction 后此处更新。"
                    : "尚无复现计划。让 Agent 调用 research_plan_reproduction 后此处更新。"}
                </div>
              )}
              {reproduction && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <Row label="复现阶段" value={reproduction.phase} status={reproduction.phase} />
                  <Row label="修复轮次" value={String(reproduction.repairRoundsUsed)} />
                  <Row label="模式" value={reproduction.agentReproduction ? "Agent 最小复现" : "官方仓库"} />
                  {reproduction.steps.map((step) => (
                    <div key={step.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontWeight: 600 }}>
                          {step.id} · {step.title}
                        </span>
                        <StageBadge state={step.status} />
                      </div>
                      {step.command && (
                        <div
                          style={{
                            fontSize: 11,
                            fontFamily: "var(--font-mono)",
                            color: "var(--text-muted)",
                            wordBreak: "break-all",
                          }}
                        >
                          {step.command}
                        </div>
                      )}
                      {step.exitCode !== null && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>exitCode: {step.exitCode}</div>
                      )}
                      {step.error && <div style={{ fontSize: 11, color: "var(--danger)" }}>{step.error}</div>}
                      {step.artifactRef && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          artifact: {step.artifactRef}
                          {step.artifactBytes !== null ? ` (${step.artifactBytes}B)` : ""}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  danger,
  status,
}: {
  label: string;
  value: string;
  mono?: boolean;
  danger?: boolean;
  status?: string;
}) {
  return (
    <div style={{ display: "flex", gap: 6, fontSize: 11, alignItems: "baseline" }}>
      <span style={{ color: "var(--text-muted)", flexShrink: 0, width: 64 }}>{label}</span>
      <span
        style={{
          flex: 1,
          wordBreak: "break-all",
          color: danger ? "var(--danger)" : status ? (stageColor[status] ?? "var(--text)") : "var(--text)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}
