"""Canonical trajectory schema, sanitization and validation for research-agent SFT data."""

from __future__ import annotations

import copy
import json
import re
from typing import Any


MAX_MESSAGES = 80
MAX_CONTENT_CHARS = 20_000
_SECRET_PATTERN = re.compile(r"(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{8,}", re.IGNORECASE)
_WINDOWS_PATH_PATTERN = re.compile(r"[A-Za-z]:\\(?:[^\s\"'<>|]+\\)*[^\s\"'<>|]*")
_UNIX_HOME_PATTERN = re.compile(r"/(?:home|Users)/[^\s\"'<>|]+")


def _sanitize_text(text: str) -> str:
    text = _SECRET_PATTERN.sub("[redacted-token]", text)
    text = _WINDOWS_PATH_PATTERN.sub("[redacted-path]", text)
    return _UNIX_HOME_PATTERN.sub("[redacted-path]", text)


def _sanitize_value(value: Any) -> Any:
    if isinstance(value, str):
        return _sanitize_text(value)
    if isinstance(value, list):
        return [_sanitize_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _sanitize_value(item) for key, item in value.items()}
    return value


def sanitize_trajectory(trajectory: dict[str, Any]) -> dict[str, Any]:
    """Return a deep, recursively sanitized copy without mutating the source."""
    return _sanitize_value(copy.deepcopy(trajectory))


def validate_trajectory(trajectory: dict[str, Any]) -> list[str]:
    """Return bounded human-readable validation errors; an empty list means valid."""
    errors: list[str] = []
    if not isinstance(trajectory, dict):
        return ["trajectory must be an object"]
    for key in ("id", "scenario", "source"):
        if not isinstance(trajectory.get(key), str) or not trajectory[key].strip():
            errors.append(f"{key} must be a non-empty string")
    if trajectory.get("source") not in {"real", "synthetic"}:
        errors.append("source must be real or synthetic")

    tools = trajectory.get("tools")
    if not isinstance(tools, list) or not tools:
        errors.append("tools must be a non-empty list")
        tool_names: set[str] = set()
    else:
        tool_names = {
            tool.get("name")
            for tool in tools
            if isinstance(tool, dict) and isinstance(tool.get("name"), str) and tool["name"]
        }
        if len(tool_names) != len(tools):
            errors.append("tool names must be present and unique")

    messages = trajectory.get("messages")
    if not isinstance(messages, list) or not messages:
        return errors + ["messages must be a non-empty list"]
    if len(messages) > MAX_MESSAGES:
        errors.append(f"messages exceed {MAX_MESSAGES}")

    pending_calls: dict[str, str] = {}
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            errors.append(f"message {index} must be an object")
            continue
        role = message.get("role")
        if role not in {"system", "user", "assistant", "tool"}:
            errors.append(f"message {index} has invalid role")
            continue
        content = message.get("content", "")
        if not isinstance(content, str) or len(content) > MAX_CONTENT_CHARS:
            errors.append(f"message {index} content is invalid or oversized")

        calls = message.get("tool_calls", [])
        if role == "assistant" and calls:
            if not isinstance(calls, list):
                errors.append(f"message {index} tool_calls must be a list")
                continue
            for call in calls:
                if not isinstance(call, dict) or not isinstance(call.get("function"), dict):
                    errors.append(f"message {index} has malformed tool call")
                    continue
                call_id = call.get("id")
                name = call["function"].get("name")
                arguments = call["function"].get("arguments")
                if not isinstance(call_id, str) or not call_id or call_id in pending_calls:
                    errors.append(f"message {index} has invalid or duplicate tool call id")
                    continue
                if name not in tool_names:
                    errors.append(f"message {index} calls unknown tool {name}")
                if not isinstance(arguments, dict):
                    errors.append(f"message {index} tool arguments must be an object")
                pending_calls[call_id] = name if isinstance(name, str) else ""

        if role == "tool":
            call_id = message.get("tool_call_id")
            name = message.get("name")
            if not isinstance(call_id, str) or call_id not in pending_calls:
                errors.append(f"message {index} has unmatched tool result")
            elif name != pending_calls.pop(call_id):
                errors.append(f"message {index} tool result name does not match its call")
            try:
                json.loads(content)
            except (TypeError, json.JSONDecodeError):
                errors.append(f"message {index} tool result must contain JSON")

    if pending_calls:
        errors.append("trajectory has tool calls without results")
    serialized = json.dumps(trajectory, ensure_ascii=False)
    if _SECRET_PATTERN.search(serialized) or _WINDOWS_PATH_PATTERN.search(serialized) or _UNIX_HOME_PATTERN.search(serialized):
        errors.append("trajectory contains an unredacted secret or local path")
    return errors[:50]

