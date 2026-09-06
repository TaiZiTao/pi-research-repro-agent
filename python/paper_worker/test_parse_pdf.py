import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import pymupdf


WORKER = Path(__file__).with_name("parse_pdf.py")


def load_worker():
    spec = importlib.util.spec_from_file_location("parse_pdf_worker", WORKER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ParsePdfTest(unittest.TestCase):
    def run_worker(self, source: Path, output: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(WORKER), str(source), str(output)],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_extracts_bounded_chunks_from_a_real_two_page_pdf(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "paper.pdf"
            output = root / "nested" / "chunks.json"
            document = pymupdf.open()
            first = document.new_page(width=612, height=5000)
            first.insert_textbox(
                pymupdf.Rect(72, 72, 540, 4900),
                "Introduction " + ("alpha beta " * 500),
            )
            second = document.new_page()
            second.insert_text((72, 72), "loss optimization 中文测试", fontname="china-s")
            document.save(source)
            document.close()

            result = self.run_worker(source, output)

            self.assertEqual(result.returncode, 0, result.stderr)
            chunks = json.loads(output.read_text(encoding="utf-8"))
            self.assertTrue(chunks)
            self.assertEqual({chunk["page"] for chunk in chunks}, {1, 2})
            expected_paper_id = hashlib.sha256(source.read_bytes()).hexdigest()
            self.assertEqual({chunk["paperId"] for chunk in chunks}, {expected_paper_id})
            self.assertGreater(len([chunk for chunk in chunks if chunk["page"] == 1]), 1)
            expected_ids = []
            for page in (1, 2):
                page_chunks = [chunk for chunk in chunks if chunk["page"] == page]
                expected_ids.extend(f"p{page}-c{ordinal}" for ordinal in range(1, len(page_chunks) + 1))
            self.assertEqual([chunk["chunkId"] for chunk in chunks], expected_ids)
            self.assertTrue(all(0 < len(chunk["text"]) <= 1200 for chunk in chunks))
            self.assertIn("中文测试", " ".join(chunk["text"] for chunk in chunks))

    def test_empty_pages_produce_no_chunks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "paper.pdf"
            output = root / "chunks.json"
            document = pymupdf.open()
            document.new_page()
            second = document.new_page()
            second.insert_text((72, 72), "only second page")
            document.save(source)
            document.close()

            result = self.run_worker(source, output)

            self.assertEqual(result.returncode, 0, result.stderr)
            chunks = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual([chunk["page"] for chunk in chunks], [2])
            self.assertEqual([chunk["chunkId"] for chunk in chunks], ["p2-c1"])

    def test_bad_arguments_fail_clearly(self) -> None:
        result = subprocess.run(
            [sys.executable, str(WORKER)], capture_output=True, text=True, check=False
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("usage", result.stderr.lower())

    def test_parse_failure_leaves_no_final_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "broken.pdf"
            output = root / "chunks.json"
            source.write_bytes(b"%PDF-not-a-document")

            result = self.run_worker(source, output)

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("failed to parse pdf", result.stderr.lower())
            self.assertFalse(output.exists())


class ChunkingContractTest(unittest.TestCase):
    def test_chunks_respect_js_utf16_length_bound_and_do_not_split_surrogates(self) -> None:
        worker = load_worker()
        astral = "U0001D400"  # mathematical bold capital A (2 UTF-16 units)
        text = ("alpha " * 250) + (astral * 400)
        chunks = worker._chunks(text)
        self.assertTrue(chunks)
        self.assertEqual("".join(chunks), text)
        for chunk in chunks:
            units = sum(2 if ord(char) > 0xFFFF else 1 for char in chunk)
            self.assertLessEqual(units, 1200)
            self.assertGreater(units, 0)

    def test_empty_and_short_texts(self) -> None:
        worker = load_worker()
        self.assertEqual(worker._chunks(""), [])
        self.assertEqual(worker._chunks("short"), ["short"])


if __name__ == "__main__":
    unittest.main()
