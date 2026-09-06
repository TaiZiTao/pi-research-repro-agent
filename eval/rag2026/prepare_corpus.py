#!/usr/bin/env python3
import json
import os
import subprocess
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PAPER_ROOT = Path(r"E:\paper\2026")
USER_DATA_ROOT = REPOSITORY_ROOT / ".artifacts" / "rag-zh20-user"
LOCAL_MANIFEST_PATH = REPOSITORY_ROOT / "eval" / "rag2026" / "corpus-manifest.local.json"
PYTHON = Path(r"D:\anaconda3\python.exe")
EMBEDDING_MODEL = "intfloat/multilingual-e5-small"
PAPERS = (
    "A lightweight multi-window attention transformer for image super-resolution.pdf",
    "Chen_AMCANet_A_Lightweight_Architecture-guided_Multi-head_Convolution_Attention_Network_for_Efficient_CVPRW_2026_paper.pdf",
    "Dual-domainModulationNetworkforLightweight.pdf",
    "Focus-guided feature fusion network for lightweight image super-resolution.pdf",
    "PDAH-SR：Prior-driven direction-aware hierarchical shunting for lightweight super-resolution.pdf",
)


def validate_dense_manifest(manifest: dict, evidence_dir: Path) -> None:
    if manifest.get("denseAvailable") is not True:
        raise ValueError("Dense index is unavailable; the benchmark must not use keyword fallback")
    if manifest.get("model") != EMBEDDING_MODEL:
        raise ValueError(f"embedding model mismatch: {manifest.get('model')!r}")
    if not isinstance(manifest.get("chunkCount"), int) or manifest["chunkCount"] <= 0:
        raise ValueError("Chunk count must be positive")
    if not (evidence_dir / "faiss.index").is_file():
        raise ValueError("faiss.index is missing")


def import_paper(pdf_path: Path) -> dict:
    env = dict(os.environ)
    env["RESEARCH_PYTHON"] = str(PYTHON)
    env["RESEARCH_EMBEDDING_MODEL"] = EMBEDDING_MODEL
    env["RESEARCH_EMBEDDING_LOCAL_ONLY"] = "1"
    command = [
        "node",
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "scripts/research-paper.mjs",
        "import",
        "--pdf",
        str(pdf_path),
        "--title",
        pdf_path.stem[:80],
        "--user-data",
        str(USER_DATA_ROOT),
    ]
    process = subprocess.run(
        command,
        cwd=REPOSITORY_ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr.strip() or process.stdout.strip() or "paper import failed")
    payload = json.loads(process.stdout)
    project = payload["project"]
    if project.get("status") != "ready":
        raise RuntimeError(f"paper import did not become ready: {project.get('error')}")
    return project


def prepare_corpus() -> dict:
    rows = []
    for filename in PAPERS:
        pdf_path = PAPER_ROOT / filename
        if not pdf_path.is_file():
            raise FileNotFoundError(pdf_path)
        project = import_paper(pdf_path)
        evidence_dir = Path(project["workspacePath"]) / "evidence"
        manifest = json.loads((evidence_dir / "manifest.json").read_text(encoding="utf-8"))
        validate_dense_manifest(manifest, evidence_dir)
        rows.append(
            {
                "paper": filename,
                "sourcePdf": str(pdf_path),
                "projectId": project["projectId"],
                "paperId": project["sha256"],
                "evidenceDir": str(evidence_dir),
                "chunkCount": manifest["chunkCount"],
                "embeddingModel": manifest["model"],
                "denseAvailable": manifest["denseAvailable"],
            }
        )
        print(f"ready\t{filename}\t{manifest['chunkCount']} chunks\tdense=true", flush=True)
    payload = {"embeddingModel": EMBEDDING_MODEL, "papers": rows}
    LOCAL_MANIFEST_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


if __name__ == "__main__":
    prepare_corpus()
