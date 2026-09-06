"""OpenAI-compatible inference server for the Qwen3 LoRA tool decisioner.

Serves POST /v1/chat/completions (OpenAI-style tools) and GET /v1/models.
Model (plus optional LoRA adapter) loads once. The model emits <tool_call>
JSON; this server converts it into OpenAI tool_calls so the Pi agent can
really execute the chosen tool. Plain-text refusals become assistant text.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for entry in (str(ROOT), str(ROOT / "eval")):
    if entry not in sys.path:
        sys.path.insert(0, entry)

from eval.metrics import parse_decision  # noqa: E402
from eval.run_eval import SYSTEM_PROMPT, TOOL_SCHEMAS  # noqa: E402

MODEL = os.environ.get("RESEARCH_QWEN_MODEL", r"E:\deepseek\models\Qwen3-0.6B")
ADAPTER = os.environ.get("RESEARCH_QWEN_ADAPTER") or None
MAX_NEW_TOKENS = int(os.environ.get("RESEARCH_QWEN_MAX_NEW_TOKENS", "192"))


def _load():
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float16, device_map="cuda")
    if ADAPTER:
        model = PeftModel.from_pretrained(model, ADAPTER)
    model.eval()
    return model, tokenizer


def _openai_error(status, message):
    return {"error": {"message": message, "type": "invalid_request_error"}}, status


def _predict(model, tokenizer, messages, tools):
    import torch

    encoded = tokenizer.apply_chat_template(
        messages,
        tools=tools,
        add_generation_prompt=True,
        enable_thinking=False,
        tokenize=True,
        return_dict=True,
        return_tensors="pt",
    ).to(model.device)
    with torch.inference_mode():
        generated = model.generate(
            **encoded,
            max_new_tokens=MAX_NEW_TOKENS,
            do_sample=False,
            pad_token_id=tokenizer.eos_token_id,
        )
    prompt_tokens = encoded["input_ids"].shape[-1]
    text = tokenizer.decode(generated[0, prompt_tokens:], skip_special_tokens=False)
    return text, parse_decision(text)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[qwen-serve] %s\n" % (fmt % args))

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_sse(self, events, finish_reason="stop", status=200):
        """Minimal OpenAI-style server-sent events: one content/tool delta, a
        finish chunk carrying finish_reason, then [DONE]. Kept single-shot
        because the underlying generation is not incremental."""
        self.send_response(status)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for event in events:
            payload = json.dumps(event, ensure_ascii=False)
            self.wfile.write(("data: %s\n\n" % payload).encode("utf-8"))
        finish_event = json.dumps({"choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}]})
        self.wfile.write(("data: %s\n\n" % finish_event).encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_GET(self):
        if self.path.rstrip("/") == "/v1/models":
            model_id = "qwen3-0.6b" + ("-lora" if ADAPTER else "")
            self._send_json({"object": "list", "data": [{"id": model_id, "object": "model", "owned_by": "local"}]})
        else:
            self._send_json(*_openai_error(404, "not found"))

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/chat/completions":
            self._send_json(*_openai_error(404, "not found"))
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as error:
            self._send_json(*_openai_error(400, "invalid request: " + type(error).__name__))
            return
        messages = request.get("messages")
        if not isinstance(messages, list) or not messages:
            self._send_json(*_openai_error(400, "messages required"))
            return
        # This model is a next-action decisioner trained against the eval
        # system prompt; keep it for protocol consistency.
        messages = list(messages)
        if not (isinstance(messages[0], dict) and messages[0].get("role") == "system"):
            messages = [{"role": "system", "content": SYSTEM_PROMPT}, *messages]
        else:
            messages[0] = {"role": "system", "content": SYSTEM_PROMPT}
        # Tool catalog policy: when the caller omits "tools" entirely (direct
        # curl demos) fall back to the eval catalog so the model still reasons
        # over research tools. When the caller sends an explicit list -- which
        # the Pi router/main model always does -- it is used verbatim and is
        # NEVER extended with static tools, so an empty active set stays empty.
        raw_tools = request.get("tools")
        if raw_tools is None:
            tools = TOOL_SCHEMAS
        elif isinstance(raw_tools, list):
            tools = raw_tools
        else:
            self._send_json(*_openai_error(400, "tools must be a list"))
            return
        started = time.perf_counter()
        try:
            text, parsed = _predict(model, tokenizer, messages, tools)
        except Exception as error:
            self._send_json(*_openai_error(500, "predict failed: " + type(error).__name__))
            return
        latency_ms = round((time.perf_counter() - started) * 1000, 1)
        action = parsed["action"]
        tool_calls = None
        content = None
        finish = "stop"
        if action not in ("__answer__", "__invalid__"):
            tool_calls = [
                {
                    "id": "call_" + uuid.uuid4().hex[:16],
                    "type": "function",
                    "function": {"name": action, "arguments": json.dumps(parsed["arguments"], ensure_ascii=False)},
                }
            ]
            finish = "tool_calls"
        else:
            content = (text or "").replace("<|im_end|>", "").replace("<|endoftext|>", "").strip() or None
        message = {"role": "assistant", "content": content}
        if tool_calls is not None:
            message["tool_calls"] = tool_calls
        model_id = "qwen3-0.6b" + ("-lora" if ADAPTER else "")
        completion_id = "chatcmpl-" + uuid.uuid4().hex[:16]
        created = int(time.time())
        if request.get("stream") is True:
            delta = {}
            if tool_calls is not None:
                delta["role"] = "assistant"
                delta["tool_calls"] = [
                    {
                        "index": 0,
                        "id": tool_calls[0]["id"],
                        "type": "function",
                        "function": {
                            "name": tool_calls[0]["function"]["name"],
                            "arguments": tool_calls[0]["function"]["arguments"],
                        },
                    }
                ]
            else:
                delta["role"] = "assistant"
                delta["content"] = content or ""
            self._send_sse(
                [
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_id,
                        "choices": [{"index": 0, "delta": delta}],
                    }
                ],
                finish_reason=finish,
            )
            return
        self._send_json(
            {
                "id": completion_id,
                "object": "chat.completion",
                "created": created,
                "model": model_id,
                "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                "latency_ms": latency_ms,
            },
        )


model = None
tokenizer = None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8123)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    global model, tokenizer
    try:
        model, tokenizer = _load()
    except Exception as error:
        sys.stderr.write("model load failed: %s\n" % (type(error).__name__))
        return 1
    print("ready model=qwen3-0.6b adapter=%s port=%s" % (bool(ADAPTER), args.port), flush=True)
    HTTPServer((args.host, args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
