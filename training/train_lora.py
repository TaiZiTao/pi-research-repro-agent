"""Train a small LoRA adapter for research-agent next-action decisions."""

from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path
from typing import Any

import torch
from peft import LoraConfig, get_peft_model
from torch.utils.data import Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments

from prepare_sft import build_examples


class DecisionDataset(Dataset):
    def __init__(self, records: list[dict[str, list[int]]]):
        self.records = records

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int) -> dict[str, list[int]]:
        return self.records[index]


class CompletionCollator:
    def __init__(self, pad_token_id: int):
        self.pad_token_id = pad_token_id

    def __call__(self, features: list[dict[str, list[int]]]) -> dict[str, torch.Tensor]:
        width = max(len(feature["input_ids"]) for feature in features)
        input_ids, attention_mask, labels = [], [], []
        for feature in features:
            pad = width - len(feature["input_ids"])
            input_ids.append(feature["input_ids"] + [self.pad_token_id] * pad)
            attention_mask.append(feature["attention_mask"] + [0] * pad)
            labels.append(feature["labels"] + [-100] * pad)
        return {
            "input_ids": torch.tensor(input_ids, dtype=torch.long),
            "attention_mask": torch.tensor(attention_mask, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
        }


def load_examples(path: Path, answer_multiplier: float = 1.0, seed: int = 42) -> list[dict[str, Any]]:
    if not 1.0 <= answer_multiplier <= 2.0:
        raise ValueError("answer_multiplier must be between 1.0 and 2.0")
    examples: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                built = build_examples(json.loads(line))
                examples.extend(built)
    answers = [example for example in examples if example["target_action"] == "__answer__"]
    extra_count = int(len(answers) * (answer_multiplier - 1.0) + 0.5)
    if extra_count:
        chosen = random.Random(seed).sample(answers, extra_count)
        examples.extend(dict(example) for example in chosen)
    return examples


def tokenize_example(tokenizer, example: dict[str, Any], max_length: int) -> dict[str, list[int]]:
    prompt = tokenizer.apply_chat_template(
        example["messages"],
        tools=example["tools"],
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    prompt_ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
    completion_ids = tokenizer(example["completion"] + tokenizer.eos_token, add_special_tokens=False)["input_ids"]
    room = max_length - len(completion_ids)
    if room <= 0:
        raise ValueError("completion exceeds max_length")
    prompt_ids = prompt_ids[-room:]
    input_ids = prompt_ids + completion_ids
    return {
        "input_ids": input_ids,
        "attention_mask": [1] * len(input_ids),
        "labels": [-100] * len(prompt_ids) + completion_ids,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--data", default="training/data/splits/train.jsonl")
    parser.add_argument("--output", default="training/outputs/qwen3-0.6b-lora-smoke")
    parser.add_argument("--max-steps", type=int, default=40)
    parser.add_argument("--max-length", type=int, default=1536)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--answer-multiplier",
        type=float,
        default=1.0,
        help="Deterministically resample __answer__ decisions between 1.0 and 2.0",
    )
    args = parser.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    examples = load_examples(Path(args.data), answer_multiplier=args.answer_multiplier, seed=args.seed)
    random.shuffle(examples)
    records = [tokenize_example(tokenizer, example, args.max_length) for example in examples]

    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float16, device_map="cuda")
    model.config.use_cache = False
    model.enable_input_require_grads()
    config = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )
    model = get_peft_model(model, config)
    trainable, total = model.get_nb_trainable_parameters()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    training_args = TrainingArguments(
        output_dir=str(output / "checkpoints"),
        per_device_train_batch_size=1,
        gradient_accumulation_steps=4,
        max_steps=args.max_steps,
        learning_rate=2e-4,
        warmup_ratio=0.05,
        lr_scheduler_type="cosine",
        logging_steps=5,
        save_strategy="no",
        report_to="none",
        fp16=True,
        gradient_checkpointing=True,
        seed=args.seed,
        data_seed=args.seed,
        remove_unused_columns=False,
    )
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=DecisionDataset(records),
        data_collator=CompletionCollator(tokenizer.pad_token_id),
    )
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    result = trainer.train()
    elapsed = round(time.perf_counter() - started, 3)
    model.save_pretrained(output / "adapter")
    tokenizer.save_pretrained(output / "adapter")
    metrics = {
        "base_model": args.model,
        "data": args.data,
        "trajectory_count": sum(1 for line in Path(args.data).read_text(encoding="utf-8").splitlines() if line.strip()),
        "example_count": len(records),
        "max_steps": args.max_steps,
        "max_length": args.max_length,
        "seed": args.seed,
        "answer_multiplier": args.answer_multiplier,
        "trainable_parameters": trainable,
        "total_parameters": total,
        "trainable_percent": round(100 * trainable / total, 4),
        "elapsed_seconds": elapsed,
        "peak_vram_gb": round(torch.cuda.max_memory_allocated() / 1024**3, 3),
        "train_loss": result.metrics.get("train_loss"),
        "log_history": trainer.state.log_history,
    }
    (output / "training_metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(metrics, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
