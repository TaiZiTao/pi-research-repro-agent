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
      <QwenServeSection />
    </div>
  );
}

interface QwenStatusRow {
  running: boolean;
  starting: boolean;
  models: string[];
  error: string | null;
  routingMode: "off" | "router" | "agent";
}

function QwenServeSection() {
  const [status, setStatus] = useState<QwenStatusRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setNotice(null);
    try {
      const result = await call("research.qwen.status");
      setStatus(result as QwenStatusRow);
    } catch (error) {
      setNotice("Status failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleStart = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await call("research.qwen.start");
      const started = result as { ok?: boolean; error?: string };
      if (started.ok) await call("research.qwen.routing.set", { mode: "agent" });
      setNotice(
        started.ok
          ? "Qwen 服务正在启动，多轮工具路由已启用（首次加载可能需要一些时间）。"
          : "Start failed: " + (started.error ?? "unknown error"),
      );
      await refresh();
    } catch (error) {
      setNotice("Start failed: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      await call("research.qwen.routing.set", { mode: "off" });
      const result = await call("research.qwen.stop");
      const stopped = result as { stopped?: boolean; error?: string };
      setNotice(
        stopped.stopped ? "Server stopped." : "Nothing to stop." + (stopped.error ? ` (${stopped.error})` : ""),
      );
      await refresh();
    } catch (error) {
      setNotice("Stop failed: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleRoutingMode = useCallback(async (mode: "off" | "router" | "agent") => {
    setBusy(true);
    setNotice(null);
    try {
      await call("research.qwen.routing.set", { mode });
      setStatus((current) => (current ? { ...current, routingMode: mode } : current));
      setNotice(
        mode === "off"
          ? "Qwen 工具路由已关闭，消息直接交给 DeepSeek。"
          : mode === "router"
            ? "已启用单次工具建议模式。"
            : "已启用多轮只读工具链，最终答案仍由 DeepSeek 生成。",
      );
    } catch (error) {
      setNotice("Routing mode failed: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }, []);

  const stateText =
    status === null
      ? "checking…"
      : status.running
        ? `running · ${status.models.join(", ")}`
        : status.starting
          ? "starting (model loading)…"
          : "stopped";
  const stateColor = status === null ? "#777" : status.running ? "#2e7d32" : status.starting ? "#b58900" : "#555";

  return (
    <div style={{ marginTop: 18, borderTop: "1px solid rgba(128,128,128,0.25)", paddingTop: 12 }}>
      <strong style={{ display: "block", marginBottom: 6 }}>Qwen 本地科研模型(工具路由器)</strong>
      <div style={{ fontSize: 12, color: "#777", lineHeight: 1.6, marginBottom: 8 }}>
        Qwen3-0.6B LoRA 是<strong>本地工具路由器(决策器)</strong>,不是主对话模型。主会话始终用
        DeepSeek(对话/规划/终答);启用后，每次用户消息先由 Qwen 在后台判断“是否调用工具/哪个/参数”，并与会话
        <strong>真实活动工具集</strong>校验。Qwen 不会出现在主模型下拉框中。
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: stateColor }}>{stateText}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleStart()}
          style={{ padding: "3px 10px", cursor: "pointer", fontSize: 12 }}
        >
          启动并启用
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleStop()}
          style={{ padding: "3px 10px", cursor: "pointer", fontSize: 12 }}
        >
          停止服务
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
          style={{ padding: "3px 10px", cursor: "pointer", fontSize: 12 }}
        >
          刷新状态
        </button>
        <select
          value={status?.routingMode ?? "off"}
          disabled={busy || !status?.running}
          onChange={(event) => void handleRoutingMode(event.target.value as "off" | "router" | "agent")}
          style={{ padding: "3px 8px", fontSize: 12 }}
          aria-label="Qwen 工具路由模式"
        >
          <option value="off">关闭路由</option>
          <option value="router">单次建议</option>
          <option value="agent">多轮只读工具链</option>
        </select>
      </div>
      {notice && <div style={{ margin: "6px 0", color: "#555", fontSize: 12 }}>{notice}</div>}
    </div>
  );
}
