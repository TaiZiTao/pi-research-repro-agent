"""Run a deterministic pre/post-LoRA tool-decision evaluation on Qwen3."""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from metrics import score_predictions


TOOLS = [
    ("research_search_papers", "Search open papers and return candidates.", {"query": "string", "limit": "integer"}, ["query"]),
    ("research_download_paper", "Download an open PDF to a managed directory.", {"url": "string"}, ["url"]),
    ("research_search_repositories", "Find repositories related to an exact paper title.", {"title": "string", "limit": "integer"}, ["title"]),
    ("research_search_evidence", "Search the current paper for page-grounded evidence.", {"query": "string", "limit": "integer"}, ["query"]),
    ("research_finalize_answer", "Validate a grounded or insufficient-evidence answer before presenting it.", {"status": "string", "answer": "string", "citations": "array"}, ["status", "answer", "citations"]),
    ("research_plan_reproduction", "Create a reproduction plan; omit repositoryUrl if no official repository is verified.", {"repositoryUrl": "string", "commitSha": "string", "license": "string", "matchBasis": "string"}, []),
    ("research_reproduction_configure_step", "Attach one allow-listed command to a pending step.", {"stepId": "string", "command": "string"}, ["stepId", "command"]),
    ("research_reproduction_execute", "Start a run or execute its next pending step.", {"action": "string"}, ["action"]),
    ("research_reproduction_verify", "Verify artifacts; repair=true resets a failed step for a bounded repair round.", {"reason": "string", "repair": "boolean"}, []),
    ("research_reproduction_report", "Render a report only after deterministic verification accepts the run.", {}, []),
]


def _schema(properties: dict[str, str], required: list[str]) -> dict:
    json_properties = {}
    for key, value_type in properties.items():
        if value_type == "array":
            json_properties[key] = {"type": "array", "items": {"type": "object"}}
        else:
            json_properties[key] = {"type": value_type}
    return {"type": "object", "properties": json_properties, "required": required, "additionalProperties": False}


TOOL_SCHEMAS = [
    {"type": "function", "function": {"name": name, "description": description, "parameters": _schema(properties, required)}}
    for name, description, properties, required in TOOLS
]


SYSTEM_PROMPT = """你是单论文科研复现 Agent 的工具决策器。只决定当前下一步。
需要工具时必须调用一个最合适的工具并填写合法参数；不要虚构工具结果。
论文事实必须先检索证据，并通过 finalize 校验；执行失败后不得宣布完成。
危险命令、Shell 链接符、任意目录删除必须直接拒绝且不得调用工具。
识别不需要工具的请求（闲聊、重复操作、已完成任务、危险请求、证据不足且校验已完成），直接一句中文回复，禁止调用工具。"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--adapter")
    parser.add_argument("--cases", default=str(Path(__file__).with_name("cases.json")))
    parser.add_argument("--output-dir", default=str(Path(__file__).with_name("results")))
    parser.add_argument("--max-new-tokens", type=int, default=192)
    args = parser.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float16, device_map="cuda")
    if args.adapter:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, args.adapter)
    model.eval()
    cases = json.loads(Path(args.cases).read_text(encoding="utf-8"))
    outputs: dict[str, str] = {}
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()

    for index, case in enumerate(cases, 1):
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": case["prompt"]},
        ]
        encoded = tokenizer.apply_chat_template(
            messages,
            tools=TOOL_SCHEMAS,
            add_generation_prompt=True,
            enable_thinking=False,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        ).to(model.device)
        with torch.inference_mode():
            generated = model.generate(
                **encoded,
                max_new_tokens=args.max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.eos_token_id,
            )
        prompt_tokens = encoded["input_ids"].shape[-1]
        outputs[case["id"]] = tokenizer.decode(generated[0, prompt_tokens:], skip_special_tokens=False)
        print(f"[{index:02d}/{len(cases):02d}] {case['id']}")

    elapsed = round(time.perf_counter() - started, 3)
    summary, details = score_predictions(cases, outputs)
    summary.update(
        {
            "model": args.model,
            "adapter": args.adapter,
            "elapsed_seconds": elapsed,
            "peak_vram_gb": round(torch.cuda.max_memory_allocated() / 1024**3, 3),
            "temperature": 0,
            "max_new_tokens": args.max_new_tokens,
        }
    )
    result = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "summary": summary,
        "details": details,
    }
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    label = "lora" if args.adapter else "base"
    output_path = output_dir / f"qwen3-0.6b-{label}.json"
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"result={output_path}")


if __name__ == "__main__":
    main()
