"""Persistent Qwen LoRA shadow predictor (stdio JSONL worker).

Loaded once per process. Reads one JSON request per line from stdin:

    {"id": "round-1", "messages": [{"role": "system", "content": "..."}, ...]}

and writes one JSON response per line to stdout:

    {"id": "round-1", "ok": true, "action": "...", "arguments": {...},
     "jsonValid": true, "latencyMs": 123}
    {"id": "round-1", "ok": false, "error": "model-unavailable"}

The tool catalog and system prompt are imported from the eval harness
(eval/run_eval.py) and parsing reuses eval/metrics.parse_decision, so the
shadow prediction speaks exactly the same protocol the training/eval harness
uses. This worker never executes tools; it only predicts.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
# run_eval.py imports its sibling module metrics with a flat import, so the
# eval directory itself must be importable for the worker to reuse it.
EVAL_DIR = str(ROOT / "eval")
if EVAL_DIR not in sys.path:
    sys.path.insert(0, EVAL_DIR)

from eval.run_eval import SYSTEM_PROMPT, TOOL_SCHEMAS  # noqa: E402
from eval.metrics import parse_decision  # noqa: E402

MODEL = os.environ.get("RESEARCH_QWEN_MODEL", r"E:\deepseek\models\Qwen3-0.6B")
ADAPTER = os.environ.get("RESEARCH_QWEN_ADAPTER", "")
MAX_NEW_TOKENS = int(os.environ.get("RESEARCH_QWEN_MAX_NEW_TOKENS", "192"))


def _load():
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    # use_fast=False: the rust fast tokenizer misbehaves inside this spawned
    # process (TextEncodeInput errors on valid str input); the slow tokenizer
    # is semantically identical for this model.
    tokenizer = AutoTokenizer.from_pretrained(MODEL, use_fast=False)
    model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float16, device_map="cuda")
    if ADAPTER:
        model = PeftModel.from_pretrained(model, ADAPTER)
    model.eval()
    return model, tokenizer


def _error(event_id: str, message: str) -> str:
    return json.dumps({"id": event_id, "ok": False, "error": message}, ensure_ascii=False)


def main() -> int:
    # Spawned by Node on Windows: stdin/stdout default to the console codepage,
    # which corrupts Chinese text. Force UTF-8 on all three streams.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    try:
        model, tokenizer = _load()
    except Exception as error:
        print(_error("", "model-unavailable: " + type(error).__name__), flush=True)
        return 1
    print(json.dumps({"event": "ready"}, ensure_ascii=False), flush=True)

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            print(_error("", "invalid-request"), flush=True)
            continue
        event_id = str(request.get("id", ""))
        messages = request.get("messages")
        if not isinstance(messages, list) or not messages:
            print(_error(event_id, "invalid-messages"), flush=True)
            continue
        # Always run with the eval harness system prompt so the shadow speaks
        # the exact same protocol the model was trained/evaluated on.
        if not messages or not isinstance(messages[0], dict) or messages[0].get("role") != "system":
            messages = [{"role": "system", "content": SYSTEM_PROMPT}, *messages]
        started = time.perf_counter()
        try:
            import torch

            rendered = tokenizer.apply_chat_template(
                messages,
                tools=TOOL_SCHEMAS,
                add_generation_prompt=True,
                enable_thinking=False,
                tokenize=False,
            )
            # Bypass the rust encode_batch path (unreliable in this spawned
            # process); tokenize via the python layer and convert ids manually.
            tokens = tokenizer.tokenize(rendered)
            ids = tokenizer.convert_tokens_to_ids(tokens)
            device = model.device
            input_ids = torch.tensor([ids], dtype=torch.long, device=device)
            attention_mask = torch.ones_like(input_ids)
            with torch.inference_mode():
                generated = model.generate(
                    input_ids=input_ids,
                    attention_mask=attention_mask,
                    max_new_tokens=MAX_NEW_TOKENS,
                    do_sample=False,
                    pad_token_id=tokenizer.eos_token_id,
                )
            prompt_tokens = input_ids.shape[-1]
            text = tokenizer.decode(generated[0, prompt_tokens:], skip_special_tokens=False)
            parsed = parse_decision(text)
            latency_ms = round((time.perf_counter() - started) * 1000, 1)
            print(
                json.dumps(
                    {
                        "id": event_id,
                        "ok": True,
                        "action": parsed["action"],
                        "arguments": parsed["arguments"],
                        "jsonValid": parsed["json_valid"],
                        "latencyMs": latency_ms,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as error:
            import traceback
            traceback.print_exc(file=sys.stderr)
            print(_error(event_id, "predict-failed: " + type(error).__name__), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())