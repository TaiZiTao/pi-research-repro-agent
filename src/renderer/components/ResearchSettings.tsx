import { useCallback, useEffect, useState } from "react";
import { call } from "@/lib/api-client";

interface ResearchProjectRow {
  projectId: string;
  title: string;
  status: string;
  pageCount: number | null;
  error: string | null;
  workspacePath: string;
  createdAt: string;
}

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 0",
  borderBottom: "1px solid rgba(128,128,128,0.2)",
};
const badge: React.CSSProperties = {
  padding: "1px 8px",
  borderRadius: 10,
  fontSize: 12,
  border: "1px solid rgba(128,128,128,0.4)",
};

function statusBadge(status: string): { text: string; color: string } {
  if (status === "ready") return { text: "ready", color: "#2e7d32" };
  if (status === "failed") return { text: "failed", color: "#c62828" };
  return { text: status, color: "#555" };
}

export function ResearchSettings() {
  const [projects, setProjects] = useState<ResearchProjectRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await call("research.list");
      setProjects(result.projects);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleImport = useCallback(async () => {
    const pdf = await window.piBridge?.selectPdfFile?.();
    if (!pdf) return;
    setBusy(true);
    setNotice(null);
    try {
      await call("research.import", { pdfPath: pdf });
      await refresh();
      setNotice("PDF imported. Open the project workspace as the session directory to chat with the agent.");
    } catch (error) {
      setNotice("Import failed: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const copyPath = useCallback((workspacePath: string) => {
    void navigator.clipboard.writeText(workspacePath);
    setNotice("Workspace path copied — paste it into the session directory box, then the research tools appear.");
  }, []);

  return (
    <div style={{ maxWidth: 760, fontFamily: "var(--font-ui, system-ui)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <strong>Research Projects</strong>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleImport()}
          style={{ padding: "4px 12px", cursor: "pointer" }}
        >
          {busy ? "Importing…" : "Import PDF…"}
        </button>
      </div>
      <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>
        Import a paper PDF, then open its workspace directory as the session directory — the research tools (search
        evidence / finalize answer / reproduction) become available to the agent in that session.
      </div>
      {notice && <div style={{ margin: "6px 0", color: "#555", fontSize: 13 }}>{notice}</div>}
      {projects.length === 0 && !busy && <div style={{ color: "#888", fontSize: 13 }}>No research projects yet.</div>}
      {projects.map((project) => {
        const badgeStyle = statusBadge(project.status);
        return (
          <div key={project.projectId} style={row}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {project.title}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "#777",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {project.workspacePath}
              </div>
              {project.error && <div style={{ fontSize: 12, color: "#c62828" }}>{project.error}</div>}
            </div>
            <span style={{ ...badge, color: badgeStyle.color, borderColor: badgeStyle.color }}>{badgeStyle.text}</span>
            {typeof project.pageCount === "number" && (
              <span style={{ fontSize: 12, color: "#777" }}>{project.pageCount}p</span>
            )}
            <button
              type="button"
              onClick={() => copyPath(project.workspacePath)}
              style={{ padding: "2px 8px", cursor: "pointer", fontSize: 12 }}
            >
              Copy path
            </button>
          </div>
        );
      })}
    </div>
  );
}
