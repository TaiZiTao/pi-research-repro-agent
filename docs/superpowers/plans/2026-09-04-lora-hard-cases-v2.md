# FP16 LoRA Hard-Case V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Qwen3-0.6B tool-action generalization by adding state-driven hard cases while preserving a clean final evaluation boundary.

**Architecture:** Keep the existing dataset and FP16 LoRA pipeline. Add one focused training-data generator for four confused actions, two independent v2 evaluation generators, and reuse the existing normalized split guard. Select the adapter on development data, then run a newly frozen final set exactly once for Base and LoRA.

**Tech Stack:** Python 3.11, PyTorch/Transformers, PEFT LoRA, JSONL, unittest/pytest, Git.

---

## File map

- Create `training/generate_hard_cases_v2.py`: generate exactly 80 state-driven tool trajectories.
- Modify `training/generate_golden.py`: append the new hard-case trajectories.
- Create `training/tests/test_hard_cases_v2.py`: lock action counts, state cues, valid schemas, and prompt uniqueness.
- Create `eval/generate_dev_v2.py`: generate the 80-case development set.
- Create `eval/generate_final_v2.py`: generate the untouched 100-case 50/50 final set.
- Modify `training/tests/test_split_sampling.py`: prove v2 train/dev/final prompt isolation.
- Generate v2 JSON/JSONL splits and committed metrics; keep adapter files ignored under `training/outputs/`.

### Task 1: Add state-driven hard-case trajectories

**Files:**

- Create: `training/tests/test_hard_cases_v2.py`
- Create: `training/generate_hard_cases_v2.py`
- Modify: `training/generate_golden.py`

- [ ] **Step 1: Write the failing generator test**

```python
from collections import Counter

from training.generate_hard_cases_v2 import generate_hard_case_trajectories
from training.schema import sanitize_trajectory, validate_trajectory


def test_generates_80_valid_state_driven_hard_cases():
    records = generate_hard_case_trajectories()
    actions = Counter(
        record["messages"][1]["tool_calls"][0]["function"]["name"]
        for record in records
    )
    assert len(records) == 80
    assert actions == {
        "research_plan_reproduction": 20,
        "research_reproduction_execute": 20,
        "research_reproduction_report": 20,
        "research_search_evidence": 20,
    }
    assert len({record["id"] for record in records}) == 80
    assert len({record["messages"][0]["content"] for record in records}) == 80
    assert all("state=" in record["messages"][0]["content"] for record in records)
    assert all(validate_trajectory(sanitize_trajectory(record)) == [] for record in records)
```

- [ ] **Step 2: Run RED**

Run: `D:\anaconda3\python.exe -m pytest training/tests/test_hard_cases_v2.py -q`

Expected: FAIL because `training.generate_hard_cases_v2` does not exist.

- [ ] **Step 3: Implement the generator**

Create four families with five state descriptions and four request variants per family. Required action/argument rules:

```python
FAMILIES = {
    "plan": (
        "research_plan_reproduction",
        [
            "paper=ready,repo=verified,plan=missing",
            "paper=ready,repo=unverified,plan=missing",
            "paper=parsed,repo=none,plan=missing",
            "paper=ready,repo=candidate_checked,plan=missing",
            "paper=imported,repo=not_found,plan=missing",
        ],
        ["建立最小复现步骤", "现在制定可执行计划", "进入复现规划阶段", "给出后续复现流程"],
    ),
    "execute": (
        "research_reproduction_execute",
        [
            "phase=planned,command=configured,next=pending",
            "phase=running,command=configured,next=pending",
            "phase=running,previous=succeeded,next=pending",
            "phase=planned,all_commands=validated,next=pending",
            "phase=running,repair=complete,next=pending",
        ],
        ["推进一次状态机", "运行已配置步骤", "执行下一项", "开始或继续运行"],
    ),
    "report": (
        "research_reproduction_report",
        [
            "phase=completed,verify=accepted,report=missing",
            "phase=completed,artifacts=verified,report=missing",
            "phase=completed,hashes=accepted,report=missing",
            "phase=completed,metrics=verified,report=missing",
            "phase=completed,all_steps=succeeded,report=missing",
        ],
        ["生成审计报告", "输出复现报告", "整理最终报告", "导出验收结果"],
    ),
    "evidence": (
        "research_search_evidence",
        [
            "paper=imported,evidence=missing,finalize=not_started",
            "paper=ready,evidence=stale,finalize=not_started",
            "paper=parsed,evidence=missing,question=metric",
            "paper=ready,evidence=missing,question=method",
            "paper=ready,evidence=missing,question=experiment",
        ],
        ["先查找原文依据", "定位论文证据", "检索对应片段", "先获得页码引用"],
    ),
}
```

Use IDs `hard-v2-<family>-01..20`. Plan/report arguments are `{}`; execute uses `begin-run` only for planned states and otherwise `next-step`; evidence uses a unique query and `limit=5`. Each record contains only user, assistant tool call, and its tool result, so these 80 cases add no extra `__answer__` decisions.

- [ ] **Step 4: Integrate with the existing corpus**

Import `generate_hard_case_trajectories` in `training/generate_golden.py` and append `*generate_hard_case_trajectories()` to `collected` before trimming final text messages.

- [ ] **Step 5: Run GREEN**

Run: `D:\anaconda3\python.exe -m pytest training/tests/test_hard_cases_v2.py training/tests/test_dataset_pipeline.py -q`

Expected: both tests pass and all generated trajectories validate.

- [ ] **Step 6: Commit**

```text
git add training/generate_hard_cases_v2.py training/generate_golden.py training/tests/test_hard_cases_v2.py
git commit -m "feat(training): add state-driven hard action cases"
```

### Task 2: Create isolated development and final sets

**Files:**

- Create: `eval/generate_dev_v2.py`
- Create: `eval/generate_final_v2.py`
- Modify: `training/tests/test_split_sampling.py`

- [ ] **Step 1: Write failing composition/isolation tests**

```python
from collections import Counter

from eval.generate_dev_v2 import build_dev_cases
from eval.generate_final_v2 import build_final_cases
from training.generate_hard_cases_v2 import generate_hard_case_trajectories
from training.split_dataset import normalize_prompt


def test_v2_eval_sets_are_unique_and_final_is_balanced():
    dev = build_dev_cases()
    final = build_final_cases()
    final_actions = Counter(case["expected_action"] for case in final)
    assert len(dev) == 80
    assert len(final) == 100
    assert final_actions["__answer__"] == 50
    assert sum(n for action, n in final_actions.items() if action != "__answer__") == 50
    assert len({case["id"] for case in [*dev, *final]}) == 180


def test_hard_training_prompts_do_not_overlap_v2_evaluation():
    train = {
        normalize_prompt(r["messages"][0]["content"])
        for r in generate_hard_case_trajectories()
    }
    evaluation = {
        normalize_prompt(c["prompt"])
        for c in [*build_dev_cases(), *build_final_cases()]
    }
    assert train.isdisjoint(evaluation)
```

- [ ] **Step 2: Run RED**

Run: `D:\anaconda3\python.exe -m pytest training/tests/test_split_sampling.py -q`

Expected: FAIL because the two v2 generator modules are missing.

- [ ] **Step 3: Implement development cases**

`build_dev_cases()` generates 80 deterministic cases: 10 for each weak action (40), two for each remaining six tools (12), and 28 no-tool cases split across casual, finalized, repeated, completed, and dangerous states. IDs start with `dev-v2-`; prompts and IDs must be unique.

- [ ] **Step 4: Implement final cases**

`build_final_cases()` generates 100 deterministic cases: five per tool for all 10 tools, plus 10 per no-tool family for five families. IDs start with `final-v2-`; use different topics, verbs, state order, URLs, titles, step IDs, and commands from training/development. Assert 100 unique IDs and prompts.

- [ ] **Step 5: Run GREEN**

Run: `D:\anaconda3\python.exe -m pytest training/tests/test_split_sampling.py -q`

Expected: all split/sampling tests pass, including composition and normalized disjointness.

- [ ] **Step 6: Commit**

```text
git add eval/generate_dev_v2.py eval/generate_final_v2.py training/tests/test_split_sampling.py
git commit -m "feat(eval): add isolated v2 development and final sets"
```

### Task 3: Build and validate v2 data

**Files:**

- Create: `eval/cases_dev_v2.json`
- Create: `eval/cases_final_v2.json`
- Create: `training/data/raw/golden_v2.jsonl`
- Create: `training/data/splits/train_v2.jsonl`
- Create: `training/data/splits/manifest_v2.json`

- [ ] **Step 1: Generate the two evaluation files**

Run:

```text
D:\anaconda3\python.exe eval\generate_dev_v2.py
D:\anaconda3\python.exe eval\generate_final_v2.py
```

Expected: 80 development cases and 100 final cases.

- [ ] **Step 2: Build raw training JSONL**

Run: `D:\anaconda3\python.exe -m training.build_dataset --output training/data/raw/golden_v2.jsonl`

Expected: 337 trajectories before exact-overlap exclusions (257 existing plus 80 hard cases).

- [ ] **Step 3: Split against both v2 sets**

Run:

```text
D:\anaconda3\python.exe training\split_dataset.py --source training\data\raw\golden_v2.jsonl --validation eval\cases_dev_v2.json --holdout eval\cases_final_v2.json --output training\data\splits\train_v2.jsonl --manifest training\data\splits\manifest_v2.json
```

Expected: manifest contains counts 80/100, both hashes, and no hard-v2 prompt overlap.

- [ ] **Step 4: Validate the training split**

Run: `D:\anaconda3\python.exe -m training.validate_dataset training\data\splits\train_v2.jsonl`

Expected: `valid=true`, no duplicate IDs, no schema errors.

- [ ] **Step 5: Commit**

```text
git add eval/cases_dev_v2.json eval/cases_final_v2.json training/data/raw/golden_v2.jsonl training/data/splits/train_v2.jsonl training/data/splits/manifest_v2.json
git commit -m "test(training): freeze v2 data and evaluation splits"
```

### Task 4: Train one FP16 LoRA v2 adapter

**Files:**

- Create, ignored: `training/outputs/qwen3-0.6b-lora-hard-v2/`

- [ ] **Step 1: Compute one-epoch steps**

Run in PowerShell and retain the computed value:

```text
$hardV2Steps = D:\anaconda3\python.exe -c "from pathlib import Path; from training.train_lora import load_examples; x=load_examples(Path('training/data/splits/train_v2.jsonl'),answer_multiplier=1.5,seed=42); print((len(x)+3)//4)"
$hardV2Steps
```

Expected: one integer equal to `ceil(example_count/4)`.

- [ ] **Step 2: Train exactly one run**

Run:

```text
D:\anaconda3\python.exe training\train_lora.py --model E:\deepseek\models\Qwen3-0.6B --data training\data\splits\train_v2.jsonl --output training\outputs\qwen3-0.6b-lora-hard-v2 --answer-multiplier 1.5 --max-steps $hardV2Steps --max-length 1536
```

Expected: exit 0, one epoch, adapter saved, peak VRAM below 8GB.

- [ ] **Step 3: Verify metrics**

Run: `D:\anaconda3\python.exe -c "import json; d=json.load(open('training/outputs/qwen3-0.6b-lora-hard-v2/training_metrics.json',encoding='utf-8')); assert d['answer_multiplier']==1.5 and d['peak_vram_gb']<8 and d['train_loss']>0; print(d['example_count'],d['train_loss'],d['peak_vram_gb'])"`

Expected: assertions pass and recorded values print.

### Task 5: Select on development data only

**Files:**

- Create: `eval/results/hard-v2-development/qwen3-0.6b-lora.json`
- Create: `eval/results/hard-v2-development/training_metrics.json`

- [ ] **Step 1: Evaluate development cases**

Run:

```text
D:\anaconda3\python.exe eval\run_eval.py --model E:\deepseek\models\Qwen3-0.6B --adapter training\outputs\qwen3-0.6b-lora-hard-v2\adapter --cases eval\cases_dev_v2.json --output-dir eval\results\hard-v2-development
```

- [ ] **Step 2: Apply the fixed gate**

```python
selected = (
    summary["action_accuracy"] >= 0.85
    and summary["over_tool_rate"] < 0.10
    and summary["json_valid_rate"] >= 0.98
)
```

If false, stop without running final inference. If true, copy training metrics into the development result directory.

- [ ] **Step 3: Commit selection evidence**

```text
git add eval/results/hard-v2-development
git commit -m "eval: select hard-case fp16 lora on development set"
```

### Task 6: Run the frozen final comparison once

**Files:**

- Create: `eval/results/final-v2-base/qwen3-0.6b-base.json`
- Create: `eval/results/final-v2-lora/qwen3-0.6b-lora.json`

- [ ] **Step 1: Run Base once**

Run: `D:\anaconda3\python.exe eval\run_eval.py --model E:\deepseek\models\Qwen3-0.6B --cases eval\cases_final_v2.json --output-dir eval\results\final-v2-base`

Expected: exactly 100 cases.

- [ ] **Step 2: Run LoRA once**

Run: `D:\anaconda3\python.exe eval\run_eval.py --model E:\deepseek\models\Qwen3-0.6B --adapter training\outputs\qwen3-0.6b-lora-hard-v2\adapter --cases eval\cases_final_v2.json --output-dir eval\results\final-v2-lora`

Expected: exactly 100 cases.

- [ ] **Step 3: Minimal final verification**

Run:

```text
D:\anaconda3\python.exe -m pytest training/tests/test_hard_cases_v2.py training/tests/test_split_sampling.py eval/tests -q
git diff --check
git status --short
```

Expected: tests pass; only final result directories are uncommitted.

- [ ] **Step 4: Commit results**

```text
git add eval/results/final-v2-base eval/results/final-v2-lora
git commit -m "eval: record frozen hard-case v2 comparison"
```

- [ ] **Step 5: Report honestly**

Report Base/LoRA action accuracy, argument match, Tool-needed F1, Over-tool Rate, JSON validity, per-action failures, training time, and peak VRAM. Label the data as self-built and do not retune this adapter against final-v2 results.
