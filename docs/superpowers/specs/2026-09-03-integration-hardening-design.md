# Research Agent Integration Hardening Design

## Goal

Turn the existing acquisition MCP and reproduction modules into a real, demonstrable single-paper workflow without claiming container-grade sandboxing.

The completed flow must let a user search and explicitly select a paper, download it into the managed directory, bind an evidence-backed repository candidate, execute a resumable reproduction plan under bounded host controls, and complete only after deterministic artifact verification.

## Scope

This slice fixes six gaps:

1. Wire acquisition and reproduction services into the Agent Host session lifecycle.
2. Require explicit user confirmation before a searched paper can be downloaded.
3. Bind official repository adoption to candidates returned by the acquisition service.
4. Let the agent supply commands or artifacts for `needs-agent` reproduction steps.
5. Reject completion while required steps are pending, failed, or missing verified artifacts.
6. Download PDFs atomically so a failed replacement cannot destroy an existing file.

Docker, WSL isolation, QLoRA, desktop UI changes, and broad workflow refactoring are outside this slice.

## Architecture

### Runtime wiring

The research runtime owns the acquisition client, candidate-selection state, repository-candidate state, and reproduction store. It initializes them once, exposes a session tool factory, and closes all resources during Agent Host shutdown.

`rpc-manager` asks the runtime for research tools for the current working directory. Acquisition tools are available before a paper project exists; evidence and reproduction tools are available only when the directory is bound to a ready project.

### Paper selection gate

`research_search_papers` stores a bounded candidate set and returns opaque candidate IDs. `research_confirm_paper` records the user's selected candidate. `research_download_paper` accepts only that confirmed candidate ID; it never accepts an arbitrary URL from the model.

A new search invalidates the previous unconsumed selection. A successful download consumes the confirmation so it cannot silently authorize another download.

### Repository provenance gate

`research_search_repositories` stores bounded repository candidates and returns opaque candidate IDs. `research_plan_reproduction` accepts a repository candidate ID rather than a URL or model-authored match explanation. The runtime resolves the candidate and persists its URL, commit SHA, license, and source-generated match basis.

Without a valid candidate, planning produces an explicitly labelled `Agent 最小复现`.

### Reproduction step progression

Add `research_reproduction_configure_step` with two mutually exclusive operations:

- attach a bounded command to the current pending step; or
- submit an existing workspace-relative artifact for a non-command step.

Artifact paths are resolved beneath the reproduction workspace. Submitting an artifact records its relative path, byte size, and SHA256 and marks the step succeeded. Commands continue to run sequentially with timeout, a command allow-list, denied shell-control patterns, and the reproduction workspace as `cwd`.

This is called **受控执行** or **guardrailed execution**, not a security sandbox.

### Deterministic completion verification

The model no longer supplies an `accepted` boolean. `research_reproduction_verify` computes the result from persisted state:

- every required step is `succeeded` or explicitly `skipped` with a recorded reason;
- every referenced artifact exists beneath the managed reproduction roots;
- its current size and SHA256 match persisted metadata;
- command steps have an exit code of zero and an execution log;
- official repository runs have a persisted repository URL and commit SHA.

Failed verification returns bounded reasons. Repair resets only failed steps and remains limited to three rounds. Pending steps can never produce `completed`.

### Atomic downloads

PDF bytes are streamed to a unique temporary file in the managed download directory. Type, size, and hash checks complete before the file is atomically renamed to its final name. Failure removes only the temporary file and preserves any previous final file.

## Data and interfaces

Candidate registries are in-memory, bounded, and scoped to the research runtime. They store no tokens and are cleared at shutdown. Candidate IDs are random opaque values and expire after a bounded interval.

Reproduction steps gain artifact metadata containing relative path, byte size, SHA256, and optional skip reason. SQLite remains the durable source of truth for reproduction state.

Tool errors remain bounded and redact managed local paths. Unknown, expired, already-consumed, or cross-project candidate IDs are rejected.

## Testing

Use focused test-first coverage only:

1. Session tool assembly exposes acquisition tools before import and reproduction tools only for a ready project.
2. Download rejects an unconfirmed candidate and consumes a confirmed candidate once.
3. Reproduction planning rejects arbitrary repository data and resolves a stored candidate.
4. Pending steps cannot complete; configured commands and submitted artifacts can advance them.
5. Missing or modified artifacts fail deterministic verification.
6. Failed PDF replacement preserves the existing final file.

Run the focused research/MCP/reproduction tests, TypeScript typecheck, lint on touched files, formatting checks, and one local end-to-end smoke flow. Do not run the unrelated full desktop test suite.

## Success criteria

- The real Agent session can list and call the new acquisition and reproduction tools.
- A paper cannot be downloaded until the user explicitly confirms a returned candidate.
- An arbitrary HTTPS repository cannot be labelled official.
- A plan containing pending or failed required steps cannot become completed.
- Every reported artifact is backed by a current size and SHA256 check.
- The product and resume wording use “受控执行” rather than “安全沙箱”.
