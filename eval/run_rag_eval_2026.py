import json, os, subprocess, sys, tempfile, pathlib
ROOT = r"E:\deepseek\pi-desktop-research"
PAPERS = r"E:\paper\2026"
USER = os.path.join(ROOT, ".artifacts", "rag-eval-user")
ANN = os.path.join(ROOT, "eval", "rag-annotations-2026.json")
env = dict(os.environ)
env["RESEARCH_PYTHON"] = r"D:\anaconda3\python.exe"

def cli(*args):
    p = subprocess.run(["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/research-paper.mjs", *args], capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=ROOT, env=env)
    if p.returncode != 0:
        raise RuntimeError(p.stderr[:500] or p.stdout[:500])
    return json.loads(p.stdout)

ann = json.load(open(ANN, encoding="utf-8"))["items"]
papers = sorted({a["paper"] for a in ann})
proj = {}
for fname in papers:
    pdf = os.path.join(PAPERS, fname)
    r = cli("import", "--pdf", pdf, "--title", pathlib.Path(fname).stem[:80], "--user-data", USER)
    pid = r["project"]["projectId"]
    proj[fname] = pid
    print("imported", fname[:50], pid, r["project"]["status"], flush=True)

def search(pid, query):
    r = cli("search", "--project", pid, "--query", query, "--limit", "5", "--user-data", USER)
    return [h["page"] for h in r["hits"]]

rows = []
for a in ann:
    pages = search(proj[a["paper"]], a["query"])
    gold = a["gold_pages"][0]
    rank = next((i + 1 for i, p in enumerate(pages) if p == gold), None)
    rows.append({**a, "returned_pages": pages, "hit_rank": rank})
    print("q", a["id"], "rank", rank, "pages", pages[:5], flush=True)

n = len(rows)
def rate(cond): return sum(1 for r in rows if cond(r)) / n
hit1 = rate(lambda r: r["hit_rank"] == 1)
hit3 = rate(lambda r: r["hit_rank"] is not None and r["hit_rank"] <= 3)
hit5 = rate(lambda r: r["hit_rank"] is not None and r["hit_rank"] <= 5)
mrr = sum(1.0 / r["hit_rank"] for r in rows if r["hit_rank"] is not None) / n
report = {"case_count": n, "hit_at_1": round(hit1, 4), "hit_at_3": round(hit3, 4), "hit_at_5": round(hit5, 4), "mrr": round(mrr, 4), "rows": rows}
out = os.path.join(ROOT, "eval", "rag-eval-2026.json")
with open(out, "w", encoding="utf-8") as fh:
    fh.write(json.dumps(report, ensure_ascii=False, indent=1))
print(json.dumps({k: report[k] for k in ("case_count", "hit_at_1", "hit_at_3", "hit_at_5", "mrr")}, ensure_ascii=False))