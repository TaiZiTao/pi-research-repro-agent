import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadError, downloadOpenPdf, safePdfFileName } from "./download.ts";

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-acq-download-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const PDF_BYTES = Buffer.from("%PDF-1.7\nmock open access document\n");

test("downloads an https pdf, writes it and reports sha256 and byte count", async (t) => {
  const dir = temporaryDirectory(t);
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return new Response(PDF_BYTES, {
      status: 200,
      headers: { "content-type": "application/pdf; charset=binary" },
    });
  };

  const result = await downloadOpenPdf("https://example.org/papers/alpha.pdf", dir, {
    fetchFn,
    maxBytes: 64,
  });

  assert.equal(path.basename(result.path), "alpha.pdf");
  assert.ok(path.isAbsolute(result.path));
  assert.equal(result.bytes, PDF_BYTES.length);
  assert.equal(result.sha256, sha256Hex(PDF_BYTES));
  assert.deepEqual(readFileSync(result.path), PDF_BYTES);
  assert.equal(calls.length, 1);
});

test("rejects non-https urls before any network call", async (t) => {
  const dir = temporaryDirectory(t);
  let called = false;
  const fetchFn = async () => {
    called = true;
    throw new Error("must not be called");
  };

  for (const url of ["http://example.org/a.pdf", "ftp://example.org/a.pdf", "file:///C:/a.pdf", "not a url"]) {
    await assert.rejects(
      downloadOpenPdf(url, dir, { fetchFn }),
      (error) => error instanceof DownloadError && /https|absolute https/i.test(error.message),
    );
  }
  assert.equal(called, false);
});

test("rejects content served as text/html", async (t) => {
  const dir = temporaryDirectory(t);
  const fetchFn = async () =>
    new Response("<html><body>not a pdf</body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  await assert.rejects(downloadOpenPdf("https://example.org/paper", dir, { fetchFn }), /not a PDF/);
  assert.deepEqual(readdirSync(dir), []);
});

test("rejects a body that has no pdf content-type and no pdf magic", async (t) => {
  const dir = temporaryDirectory(t);
  const fetchFn = async () => new Response(Buffer.from("hello world, definitely not a pdf"), { status: 200 });

  await assert.rejects(downloadOpenPdf("https://example.org/paper.pdf", dir, { fetchFn }), /not a PDF/);
  assert.deepEqual(readdirSync(dir), []);
});

test("accepts a pdf when only the magic signature proves the type", async (t) => {
  const dir = temporaryDirectory(t);
  const fetchFn = async () => new Response(PDF_BYTES, { status: 200 });

  const result = await downloadOpenPdf("https://example.org/magic-only.pdf", dir, { fetchFn });
  assert.equal(result.sha256, sha256Hex(PDF_BYTES));
  assert.equal(path.basename(result.path), "magic-only.pdf");
});

test("aborts streaming once maxBytes is exceeded and leaves no file behind", async (t) => {
  const dir = temporaryDirectory(t);
  const chunk = new Uint8Array(16).fill(0x41);
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetchFn = async () =>
    new Response(stream, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });

  await assert.rejects(
    downloadOpenPdf("https://example.org/big.pdf", dir, { fetchFn, maxBytes: 24 }),
    /exceeds the 24 byte limit/,
  );
  assert.equal(cancelled, true);
  assert.deepEqual(readdirSync(dir), []);
});

test("rejects traversal file names and relative target directories", async (t) => {
  const dir = temporaryDirectory(t);
  let called = false;
  const fetchFn = async () => {
    called = true;
    throw new Error("must not be called");
  };

  for (const fileName of ["../../evil.pdf", "..\\evil.pdf", "..", "sub/paper.pdf", ""]) {
    await assert.rejects(
      downloadOpenPdf("https://example.org/a.pdf", dir, { fetchFn, fileName }),
      (error) => error instanceof DownloadError && /basename|plain file name|at most/i.test(error.message),
    );
  }
  await assert.rejects(downloadOpenPdf("https://example.org/a.pdf", "relative/dir", { fetchFn }), /absolute path/);
  assert.equal(called, false);
});

test("safePdfFileName strips paths and unsafe characters and falls back", () => {
  assert.equal(safePdfFileName("https://arxiv.org/pdf/2401.12345"), "2401.12345.pdf");
  assert.equal(safePdfFileName("../../etc/passwd"), "passwd.pdf");
  assert.equal(safePdfFileName("hello world: v2!"), "hello-world-v2.pdf");
  assert.equal(safePdfFileName("https://a.test/x?y=1"), "x.pdf");
  assert.equal(safePdfFileName(""), "paper.pdf");
  assert.equal(safePdfFileName("..."), "paper.pdf");
  const long = safePdfFileName("long".repeat(100) + ".pdf");
  assert.ok(long.endsWith(".pdf"));
  assert.ok(long.length <= 124, "derived file name stays bounded");
});
