import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createInMemoryAcquisitionTransport,
  createResearchAcquisitionClient,
  ResearchAcquisitionClientError,
  redactSecrets,
} from "./mcp-client.ts";
import { MAX_ERROR_MESSAGE_CHARS } from "../../../mcp/research-acquisition/types.ts";

const SAMPLE_CANDIDATE = {
  id: "2401.00001",
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani"],
  year: 2017,
  venue: null,
  abstract: "An attention based architecture.",
  pdfUrl: "https://arxiv.org/pdf/2401.00001",
  source: "arxiv",
  identifiers: { arxiv: "2401.00001" },
};

const SAMPLE_REPOSITORY = {
  name: "attention",
  fullName: "user/attention",
  url: "https://github.com/user/attention",
  description: "Implementation of attention.",
  license: "MIT",
  defaultBranch: "main",
  commitSha: "abcd1234",
  matchBasis: "title-keywords:Attention",
  stars: 42,
};

function makeServerStubs(recorded) {
  return {
    searchPapers: async (query, limit) => {
      recorded.search = { query, limit };
      return [SAMPLE_CANDIDATE];
    },
    downloadPdf: async (url, targetDir) => {
      recorded.download = { url, targetDir };
      return { path: path.join(targetDir, "out.pdf"), sha256: "a".repeat(64), bytes: 12 };
    },
    searchRepositories: async (title, limit) => {
      recorded.repos = { title, limit };
      return [SAMPLE_REPOSITORY];
    },
  };
}

/** Wraps the in-memory transport so tests can observe lazy connection counts. */
function countingTransport(serverOptions) {
  let connects = 0;
  const inner = createInMemoryAcquisitionTransport({ serverOptions });
  return {
    connects: () => connects,
    connect: async () => {
      connects += 1;
      return inner.connect();
    },
  };
}

async function closeQuietly(client) {
  try {
    await client.close();
  } catch {
    // already closed
  }
}

test("redactSecrets replaces registered long secrets and ignores short or empty ones", () => {
  assert.equal(
    redactSecrets("boom ghp_supersecret again ghp_supersecret", ["ghp_supersecret"]),
    "boom [redacted] again [redacted]",
  );
  assert.equal(redactSecrets("nothing to hide", ["ghp_supersecret"]), "nothing to hide");
  assert.equal(redactSecrets("keep short xyz", ["xyz"]), "keep short xyz");
  assert.equal(redactSecrets("keep empty marker", [""]), "keep empty marker");
  assert.equal(redactSecrets("clean", [undefined, ""]), "clean");
});

test("client connects lazily and searchPapers/downloadPaper/searchRepositories return parsed results", async () => {
  const recorded = {};
  const transport = countingTransport(makeServerStubs(recorded));
  const client = await createResearchAcquisitionClient({ transport, timeoutMs: 1000 });
  assert.equal(transport.connects(), 0, "construction must not connect");

  const candidates = await client.searchPapers("attention is all you need", 3);
  assert.equal(transport.connects(), 1, "first call connects exactly once");
  assert.deepEqual(candidates, [SAMPLE_CANDIDATE]);
  assert.deepEqual(recorded.search, { query: "attention is all you need", limit: 3 });

  const dir = path.resolve("pi-acq-download-target");
  const download = await client.downloadPaper("https://example.org/paper.pdf", dir);
  assert.equal(download.sha256, "a".repeat(64));
  assert.equal(download.bytes, 12);
  assert.equal(download.path, path.join(dir, "out.pdf"));
  assert.deepEqual(recorded.download, { url: "https://example.org/paper.pdf", targetDir: dir });
  assert.ok(path.isAbsolute(recorded.download.targetDir));

  const repositories = await client.searchRepositories("Graph Neural Networks for Molecule Prediction");
  assert.deepEqual(repositories, [SAMPLE_REPOSITORY]);
  assert.deepEqual(recorded.repos, {
    title: "Graph Neural Networks for Molecule Prediction",
    limit: 5,
  });
  assert.equal(transport.connects(), 1, "the established connection is reused");

  await closeQuietly(client);
});

test("out-of-bounds arguments reject with bounded ResearchAcquisitionClientError before connecting", async () => {
  const recorded = {};
  const transport = countingTransport(makeServerStubs(recorded));
  const client = await createResearchAcquisitionClient({ transport, timeoutMs: 1000 });

  const rejectsBounded = async (promise, pattern) => {
    await assert.rejects(
      promise,
      (error) =>
        error instanceof ResearchAcquisitionClientError &&
        error.name === "ResearchAcquisitionClientError" &&
        pattern.test(error.message) &&
        error.message.length <= MAX_ERROR_MESSAGE_CHARS,
    );
  };

  await rejectsBounded(client.searchPapers(""), /"query" must be between 1 and 200/);
  await rejectsBounded(client.searchPapers("   "), /"query" must not be empty/);
  await rejectsBounded(client.searchPapers("x".repeat(201)), /"query" must be between 1 and 200/);
  await rejectsBounded(client.searchPapers("ok", 0), /"limit" must be an integer between 1 and 20/);
  await rejectsBounded(client.searchPapers("ok", 21), /"limit" must be an integer between 1 and 20/);
  await rejectsBounded(client.searchPapers("ok", 2.5), /"limit" must be an integer between 1 and 20/);
  await rejectsBounded(
    client.downloadPaper("https://example.org/" + "a".repeat(2000), path.resolve(".")),
    /"url" must be between 1 and 2000/,
  );
  await rejectsBounded(
    client.downloadPaper("https://example.org/a.pdf", "relative/dir"),
    /"targetDir" must be an absolute path/,
  );
  await rejectsBounded(client.downloadPaper("https://example.org/a.pdf", ""), /"targetDir" must be between 1 and 2000/);
  await rejectsBounded(client.searchRepositories("t".repeat(301)), /"title" must be between 1 and 300/);
  await rejectsBounded(
    client.searchRepositories("Graph Neural Networks", 11),
    /"limit" must be an integer between 1 and 10/,
  );
  await rejectsBounded(
    client.searchRepositories("Graph Neural Networks", 0),
    /"limit" must be an integer between 1 and 10/,
  );

  assert.equal(transport.connects(), 0, "validation failures must not open a connection");
  assert.deepEqual(recorded, {});
  await closeQuietly(client);
});

test("slow servers make the client reject with a bounded timed-out error", async () => {
  const recorded = {};
  const client = await createResearchAcquisitionClient({
    timeoutMs: 30,
    secrets: ["ghp_secret"],
    transport: createInMemoryAcquisitionTransport({
      serverOptions: {
        // The stub itself sleeps far longer than the client timeout.
        searchPapers: async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          recorded.search = { done: true };
          return [SAMPLE_CANDIDATE];
        },
      },
    }),
  });

  const started = Date.now();
  await assert.rejects(
    client.searchPapers("slow upstream"),
    (error) =>
      error instanceof ResearchAcquisitionClientError &&
      error.name === "ResearchAcquisitionClientError" &&
      /timed out/.test(error.message) &&
      error.message.length <= MAX_ERROR_MESSAGE_CHARS,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3_000, `expected a fast timeout rejection, took ${elapsed} ms`);
  assert.ok(elapsed >= 20, `timeout fired suspiciously early: ${elapsed} ms`);

  // Let the abandoned server-side call settle before releasing the pair.
  await new Promise((resolve) => setTimeout(resolve, 320));
  await closeQuietly(client);
  assert.deepEqual(recorded.search, { done: true });
});

test("raw client failures are scrubbed through redactSecrets", async () => {
  const failingTransport = {
    connect: async () => ({
      client: {
        listTools: async () => ({}),
        callTool: async () => {
          throw new Error("boom ghp_supersecretToken");
        },
        close: async () => {},
      },
      close: async () => {},
    }),
  };
  const client = await createResearchAcquisitionClient({
    transport: failingTransport,
    timeoutMs: 500,
    secrets: ["ghp_supersecretToken"],
  });
  await assert.rejects(
    client.searchPapers("attention"),
    (error) =>
      error instanceof ResearchAcquisitionClientError &&
      error.name === "ResearchAcquisitionClientError" &&
      !error.message.includes("ghp_supersecretToken") &&
      error.message.includes("[redacted]") &&
      error.message.length <= MAX_ERROR_MESSAGE_CHARS,
  );
});

test("server-side stub failures surface as bounded redacted client errors", async () => {
  const client = await createResearchAcquisitionClient({
    timeoutMs: 500,
    secrets: ["ghp_token1234"],
    transport: createInMemoryAcquisitionTransport({
      serverOptions: {
        searchPapers: async () => {
          throw new Error("boom ghp_token1234");
        },
      },
    }),
  });
  await assert.rejects(
    client.searchPapers("attention"),
    (error) =>
      error instanceof ResearchAcquisitionClientError &&
      !error.message.includes("ghp_token1234") &&
      error.message.length <= MAX_ERROR_MESSAGE_CHARS,
  );
  await closeQuietly(client);
});

test("malformed textual results reject with a bounded parse error", async () => {
  const brokenTransport = {
    connect: async () => ({
      client: {
        listTools: async () => ({}),
        callTool: async () => ({ content: [{ type: "text", text: "this is not json" }] }),
        close: async () => {},
      },
      close: async () => {},
    }),
  };
  const client = await createResearchAcquisitionClient({ transport: brokenTransport, timeoutMs: 500 });
  await assert.rejects(
    client.searchPapers("attention"),
    (error) => error instanceof ResearchAcquisitionClientError && /invalid JSON/.test(error.message),
  );
});

test("close is idempotent and later calls reject as closed", async (t) => {
  const recorded = {};
  const transport = countingTransport(makeServerStubs(recorded));
  const client = await createResearchAcquisitionClient({ transport, timeoutMs: 1000 });
  t.after(() => closeQuietly(client));

  assert.deepEqual(await client.searchPapers("first call", 1), [SAMPLE_CANDIDATE]);
  assert.equal(transport.connects(), 1);

  await client.close();
  await client.close();
  await client.close();
  await assert.rejects(
    client.searchPapers("after close"),
    (error) => error instanceof ResearchAcquisitionClientError && /is closed/.test(error.message),
  );
});
