"""Convert validated research trajectories into next-action SFT examples."""

from __future__ import annotations

import json
from typing import Any


TOOL_DESCRIPTIONS: dict[str, tuple[str, dict[str, Any]]] = {
    "research_search_papers": (
        "Search open papers and return candidates.",
        {"query": {"type": "string"}, "limit": {"type": "integer"}},
    ),
    "research_download_paper": (
        "Download an open PDF to a managed directory.",
        {"url": {"type": "string"}},
    ),
    "research_search_repositories": (
        "Find repositories related to an exact paper title.",
        {"title": {"type": "string"}, "limit": {"type": "integer"}},
    ),
    "research_search_evidence": (
        "Search the current paper for page-grounded evidence.",
        {"query": {"type": "string"}, "limit": {"type": "integer"}},
    ),
    "research_finalize_answer": (
        "Validate a grounded or insufficient-evidence answer before presenting it.",
        {
            "status": {"type": "string"},
            "answer": {"type": "string"},
            "citations": {"type": "array", "items": {"type": "object"}},
        },
    ),
    "research_plan_reproduction": (
        "Create a reproduction plan; omit repositoryUrl unless an official repository is verified.",
        {
            "repositoryUrl": {"type": "string"},
            "commitSha": {"type": "string"},
            "license": {"type": "string"},
            "matchBasis": {"type": "string"},
        },
    ),
    "research_reproduction_configure_step": (
        "Attach one allow-listed command to a pending step.",
        {"stepId": {"type": "string"}, "command": {"type": "string"}},
    ),
    "research_reproduction_execute": (
        "Start a run or execute its next pending step.",
        {"action": {"type": "string"}},
    ),
    "research_reproduction_verify": (
        "Verify artifacts; repair=true starts one bounded repair round after failure.",
        {"reason": {"type": "string"}, "repair": {"type": "boolean"}},
    ),
    "research_reproduction_report": ("Render a report after deterministic verification.", {}),
}

REQUIRED_ARGUMENTS = {
    "research_search_papers": ["query"],
    "research_download_paper": ["url"],
    "research_search_repositories": ["title"],
    "research_search_evidence": ["query"],
    "research_finalize_answer": ["status", "answer", "citations"],
    "research_reproduction_configure_step": ["stepId", "command"],
    "research_reproduction_execute": ["action"],
}

SYSTEM_PROMPT = """你是单论文科研复现 Agent 的工具决策器。只决定当前下一步。
需要工具时必须调用一个最合适的工具并填写合法参数；不要虚构工具结果。
论文事实必须先检索证据，并通过 finalize 校验；执行失败后不得宣布完成。
危险命令、Shell 链接符、任意目录删除必须直接拒绝且不得调用工具。
不需要工具时用一句中文直接回答。"""


def tool_schemas(tool_names: list[str]) -> list[dict[str, Any]]:
    schemas = []
    for name in tool_names:
        if name not in TOOL_DESCRIPTIONS:
            continue
        description, properties = TOOL_DESCRIPTIONS[name]
        schemas.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": description,
                    "parameters": {
                        "type": "object",
                        "properties": properties,
                        "required": REQUIRED_ARGUMENTS.get(name, []),
                        "additionalProperties": False,
                    },
                },
            }
        )
    return schemas


def _assistant_completion(message: dict[str, Any]) -> tuple[str, str]:
    calls = message.get("tool_calls") or []
    if calls:
        call = calls[0]["function"]
        payload = {"name": call["name"], "arguments": call["arguments"]}
        return f"<tool_call>\n{json.dumps(payload, ensure_ascii=False)}\n</tool_call>", call["name"]
    return message.get("content", ""), "__answer__"


def _normalize_context(message: dict[str, Any]) -> dict[str, str]:
    role = message["role"]
    if role == "assistant":
        content, _ = _assistant_completion(message)
        return {"role": role, "content": content}
    return {"role": role, "content": message.get("content", "")}


def build_examples(trajectory: dict[str, Any], max_context_messages: int = 4) -> list[dict[str, Any]]:
    # Match the ready-project Pi runtime: every decision sees the same complete
    # catalog instead of a scenario-specific subset that leaks the target class.
    schemas = tool_schemas(list(TOOL_DESCRIPTIONS))
    history: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    examples = []
    for message in trajectory["messages"]:
        if message["role"] == "assistant":
            completion, target_action = _assistant_completion(message)
            recent = history[-max_context_messages:]
            if recent and recent[0]["role"] != "system":
                recent = [history[0], *recent]
            examples.append(
                {
                    "trajectory_id": trajectory["id"],
                    "messages": recent,
                    "tools": schemas,
                    "completion": completion,
                    "target_action": target_action,
                }
            )
        history.append(_normalize_context(message))
    return examples
