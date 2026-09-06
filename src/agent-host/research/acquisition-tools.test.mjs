import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createResearchAcquisitionTools } from "./tools.ts";
import { createInMemoryAcquisitionTransport, createResearchAcquisitionClient } from "./mcp-client.ts";
import { researchAcquisitionAvailable, researchAcquisitionDownloadsRoot } from "./runtime.ts";

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

function makeStubClient(calls) {
  return {
    searchPapers: async (query, limit) => {
      calls.push(["search", query, limit]);
      return [SAMPLE_CANDIDATE];
    },
    downloadPaper: async (url, targetDir) => {
      calls.push(["download", url, targetDir]);
      return { path: path.join(targetDir, "paper.pdf"), sha256: "b".repeat(64), bytes: 42 };
    },
    searchRepositories: async (title, limit) => {
      calls.push(["repos", title, limit]);
      return [SAMPLE_REPOSITORY];
    },
    close: async () => {},
  };
}

test("defines three bounded acquisition tools; download only accepts url", () => {
  const downloadsRoot = path.resolve("pi-acq-downloads");
  const [search, download, repos] = createResearchAcquisitionTools(path.resolve("pi-acq-workspace"), {
    client: makeStubClient([]),
    downloadsRoot,
  });

  assert.equal(search.name, "research_search_papers");
  assert.equal(search.label, "search research papers");
  assert.equal(search.executionMode, "sequential");
  assert.deepEqual(Object.keys(search.parameters.properties), ["query", "limit"]);
  assert.equal(search.parameters.properties.query.minLength, 1);
  assert.equal(search.parameters.properties.query.maxLength, 200);
  assert.equal(search.parameters.properties.limit.minimum, 1);
  assert.equal(search.parameters.properties.limit.maximum, 20);
  assert.equal(search.parameters.additionalProperties, false);
  assert.match(search.description, /research-acquisition data/);

  assert.equal(download.name, "research_download_paper");
  assert.equal(download.executionMode, "sequential");
  assert.deepEqual(Object.keys(download.parameters.properties), ["url"], "the model can never pick a target dir");
  assert.equal(download.parameters.properties.url.maxLength, 2000);
  assert.equal(download.parameters.additionalProperties, false);
  assert.match(download.description, /fixed managed downloads directory/i);
  assert.match(download.description, /never grants arbitrary disk write access/i);

  assert.equal(repos.name, "research_search_repositories");
  assert.equal(repos.executionMode, "sequential");
  assert.deepEqual(Object.keys(repos.parameters.properties), ["title", "limit"]);
  assert.equal(repos.parameters.properties.title.maxLength, 300);
  assert.equal(repos.parameters.properties.limit.minimum, 1);
  assert.equal(repos.parameters.properties.limit.maximum, 10);
  assert.equal(repos.parameters.additionalProperties, false);
});

test("search and download tools delegate to the client with the fixed downloadsRoot", async () => {
  const calls = [];
  const downloadsRoot = path.resolve("pi-acq-downloads");
  const [search, download, repos] = createResearchAcquisitionTools(path.resolve("pi-acq-workspace"), {
    client: makeStubClient(calls),
    downloadsRoot,
  });
  const signal = new globalThis.AbortController().signal;

  const searched = await search.execute("call-1", { query: "graph neural networks", limit: 3 }, signal);
  assert.deepEqual(calls[0], ["search", "graph neural networks", 3]);
  assert.deepEqual(JSON.parse(searched.content[0].text), { candidates: [SAMPLE_CANDIDATE] });
  assert.deepEqual(searched.details, { candidates: [SAMPLE_CANDIDATE] });

  const downloaded = await download.execute("call-2", { url: "https://example.org/paper.pdf" }, signal);
  assert.deepEqual(calls[1], ["download", "https://example.org/paper.pdf", downloadsRoot]);
  const expectedDownload = {
    path: path.join(downloadsRoot, "paper.pdf"),
    sha256: "b".repeat(64),
    bytes: 42,
  };
  assert.deepEqual(JSON.parse(downloaded.content[0].text), expectedDownload);
  assert.deepEqual(downloaded.details, expectedDownload);

  const repositories = await repos.execute("call-3", { title: "Graph Neural Networks" }, signal);
  assert.deepEqual(calls[2], ["repos", "Graph Neural Networks", undefined]);
  assert.deepEqual(JSON.parse(repositories.content[0].text), { repositories: [SAMPLE_REPOSITORY] });
  assert.deepEqual(repositories.details, { repositories: [SAMPLE_REPOSITORY] });
});

test("client failures become bounded tool error text without leaking local directories", async () => {
  const downloadsRoot = path.resolve("pi-acq-secret-downloads");
  const workspace = path.resolve("pi-acq-secret-workspace");
  const failing = makeStubClient([]);
  failing.searchPapers = async () => {
    throw new Error(`write failed near ${downloadsRoot} (cwd ${workspace})`);
  };
  const [search] = createResearchAcquisitionTools(workspace, { client: failing, downloadsRoot });

  const result = await search.execute("call-1", { query: "attention" }, new globalThis.AbortController().signal);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(typeof payload.error, "string");
  assert.ok(payload.error.length <= 500, `bounded tool error expected, got ${payload.error.length} chars`);
  assert.ok(!payload.error.includes(downloadsRoot), "downloadsRoot must not leak");
  assert.ok(!payload.error.includes(workspace), "cwd must not leak");
  assert.ok(payload.error.includes("[redacted]"));
  assert.deepEqual(result.details, { error: payload.error });
});

test("real sanitizing client failures reach the model without secrets", async (t) => {
  const downloadsRoot = path.resolve("pi-acq-managed-downloads");
  const client = await createResearchAcquisitionClient({
    timeoutMs: 500,
    secrets: ["ghp_supersecret"],
    transport: createInMemoryAcquisitionTransport({
      serverOptions: {
        searchPapers: async () => {
          throw new Error("boom ghp_supersecret");
        },
      },
    }),
  });
  t.after(async () => {
    try {
      await client.close();
    } catch {
      // already closed
    }
  });

  const [search] = createResearchAcquisitionTools(path.resolve("pi-acq-workspace"), { client, downloadsRoot });
  const result = await search.execute("call-1", { query: "attention" }, new globalThis.AbortController().signal);
  const payload = JSON.parse(result.content[0].text);
  assert.ok(!payload.error.includes("ghp_supersecret"));
  assert.ok(payload.error.length <= 500);
});

test("acquisition availability and downloads root follow PI_DESKTOP_USER_DATA", () => {
  assert.equal(researchAcquisitionAvailable({}), false);
  assert.equal(researchAcquisitionDownloadsRoot({}), undefined);
  assert.equal(researchAcquisitionDownloadsRoot({ PI_DESKTOP_USER_DATA: "relative" }), undefined);

  const userData = path.resolve("pi-acq-user-data");
  const env = { PI_DESKTOP_USER_DATA: userData };
  assert.equal(researchAcquisitionAvailable(env), true);
  assert.equal(researchAcquisitionDownloadsRoot(env), path.join(userData, "research", "downloads"));
});
