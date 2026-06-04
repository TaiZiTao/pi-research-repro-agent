import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { call } from "@/lib/api-client";
import { mapWorkflowStages, type WorkflowStage } from "./mapping.ts";

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
  project: ProjectRow & { sourcePdfName: string; sha256: string; updatedAt: string };
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
  recentEvents: unknown[];
}

interface ResearchPanelProps {
  open: boolean;
  sessionCwd: string | null;
  onClose: () => void;
}

const stageColor: Record<string, string> = {
  pending: "var(--text-dim)",
  running: "var(--accent)",
  succeeded: "#2e9e5b",
  failed: "var(--danger)",
  blocked: "#b58900",
};

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

export function ResearchPanel({ open, sessionCwd, onClose }: ResearchPanelProps) {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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

  if (!open) return null;
  const project = detail?.project ?? null;
  const reproduction = detail?.reproduction ?? null;
  const stages: WorkflowStage[] = mapWorkflowStages(project, reproduction);
  const status = project?.status ?? null;
  return (
    <div
      role="dialog"
      aria-label="Research panel"
      style={{
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
      }}
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
            <Section title="3 · 引用与证据" defaultOpen={false}>
              <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
                对话中执行 research_search_evidence / research_finalize_answer
                后,此处会显示页码、chunk_id、分数与原文(集成中;当前显示空态)。
              </div>
            </Section>
            <Section title="4 · 日志与产物" defaultOpen={false}>
              {!reproduction && (
                <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
                  尚无复现计划。让 Agent 调用 research_plan_reproduction 后此处更新。
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
