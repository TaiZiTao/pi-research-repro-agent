"""Deterministic metrics for one-step research-agent tool decisions."""

from __future__ import annotations

import json
import re
from typing import Any


_TOOL_CALL = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)


def parse_decision(text: str) -> dict[str, Any]:
    """Parse Qwen's first tool call; plain text is a deliberate final answer/refusal.

    tool_attempted is True whenever the output contains a <tool_call> marker,
    regardless of whether its JSON is valid. Only a plain-text answer (no
    marker at all) counts as tool_attempted=False.
    """
    match = _TOOL_CALL.search(text)
    if not match:
        if "<tool_call>" in text:
            # A malformed or unterminated tool attempt is still an attempt: it
            # must never be scored as if the model chose to answer directly.
            return {"action": "__invalid__", "arguments": {}, "json_valid": False, "tool_attempted": True}
        return {"action": "__answer__", "arguments": {}, "json_valid": True, "tool_attempted": False}
    try:
        value = json.loads(match.group(1))
    except json.JSONDecodeError:
        return {"action": "__invalid__", "arguments": {}, "json_valid": False, "tool_attempted": True}
    if not isinstance(value, dict):
        return {"action": "__invalid__", "arguments": {}, "json_valid": False, "tool_attempted": True}
    action = value.get("name")
    arguments = value.get("arguments")
    valid = isinstance(action, str) and isinstance(arguments, dict)
    return {
        "action": action if valid else "__invalid__",
        "arguments": arguments if isinstance(arguments, dict) else {},
        "json_valid": valid,
        "tool_attempted": True,
    }


def _required_arguments_match(expected: dict[str, Any], actual: dict[str, Any]) -> bool:
    return all(key in actual and actual[key] == value for key, value in expected.items())


def _safe_ratio(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def score_predictions(
    cases: list[dict[str, Any]], outputs: dict[str, str]
) -> tuple[dict[str, float | int], list[dict[str, Any]]]:
    details: list[dict[str, Any]] = []
    tp = fp = fn = 0
    json_valid = action_correct = argument_correct = 0
    tool_cases = 0
    answer_cases = 0
    over_tool = 0

    for case in cases:
        parsed = parse_decision(outputs.get(case["id"], ""))
        expected_action = case["expected_action"]
        expected_tool = expected_action != "__answer__"
        # Any <tool_call> marker counts as a tool attempt, even when its JSON
        # is malformed; never infer "no tool" from action == __invalid__.
        predicted_tool = parsed["tool_attempted"]
        if expected_tool and predicted_tool:
            tp += 1
        elif predicted_tool:
            fp += 1
        elif expected_tool:
            fn += 1

        if not expected_tool:
            # Over-tool rate: how often the model calls a tool when a plain
            # answer (refusal, direct answer) is the expected action.
            answer_cases += 1
            if predicted_tool:
                over_tool += 1

        action_ok = parsed["action"] == expected_action
        if parsed["json_valid"]:
            json_valid += 1
        if action_ok:
            action_correct += 1

        args_ok: bool | None = None
        if expected_tool:
            tool_cases += 1
            args_ok = action_ok and _required_arguments_match(
                case.get("required_arguments", {}), parsed["arguments"]
            )
            if args_ok:
                argument_correct += 1

        details.append(
            {
                "id": case["id"],
                "category": case["category"],
                "expected_action": expected_action,
                "predicted_action": parsed["action"],
                "json_valid": parsed["json_valid"],
                "tool_attempted": parsed["tool_attempted"],
                "action_correct": action_ok,
                "arguments_correct": args_ok,
                "raw_output": outputs.get(case["id"], ""),
            }
        )

    precision = _safe_ratio(tp, tp + fp)
    recall = _safe_ratio(tp, tp + fn)
    f1 = round(2 * precision * recall / (precision + recall), 4) if precision + recall else 0.0
    total = len(cases)
    return (
        {
            "case_count": total,
            "json_valid_rate": _safe_ratio(json_valid, total),
            "action_accuracy": _safe_ratio(action_correct, total),
            "argument_match_rate": _safe_ratio(argument_correct, tool_cases),
            "tool_needed_f1": f1,
            "answer_case_count": answer_cases,
            "over_tool_rate": _safe_ratio(over_tool, answer_cases),
        },
        details,
    )
