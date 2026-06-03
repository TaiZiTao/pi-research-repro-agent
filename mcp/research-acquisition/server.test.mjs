import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createResearchAcquisitionServer, githubSearchQuery, RESEARCH_ACQUISITION_TOOLS } from "./server.ts";

const noNetwork = async () => {
  throw new Error("test accidentally touched the network");
};

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

function makeStubs(recorded) {
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

async function startPair(t, options = {}) {
  const server = createResearchAcquisitionServer({ fetchFn: noNetwork, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "server-test-client", version: "0.0.0" });
  // Server first: client.connect awaits the initialize response which only
  // arrives once the server transport is started.
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    try {
      await client.close();
    } catch {
      // already closed
    }
    try {
      await server.close();
    } catch {
      // already closed
    }
  });
  return { server, client };
}

function textOf(result) {
  return result.content[0].text;
}

test("listTools advertises exactly the three research-acquisition tools", async (t) => {
  const { client } = await startPair(t);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["download_paper", "search_papers", "search_repositories"]);
  assert.deepEqual(RESEARCH_ACQUISITION_TOOLS.map((tool) => tool.name).sort(), names);
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get("search_papers").inputSchema.required[0], "query");
  assert.equal(byName.get("search_papers").inputSchema.properties.query.maxLength, 200);
  assert.equal(byName.get("search_papers").inputSchema.properties.limit.maximum, 20);
  assert.equal(byName.get("download_paper").inputSchema.properties.url.maxLength, 2000);
  assert.equal(byName.get("download_paper").inputSchema.required.length, 2);
  assert.equal(byName.get("search_repositories").inputSchema.properties.title.maxLength, 300);
  assert.equal(byName.get("search_repositories").inputSchema.properties.limit.maximum, 10);
});

test("search_papers runs the injected stub and returns candidate json", async (t) => {
  const recorded = {};
  const { client } = await startPair(t, makeStubs(recorded));
  const result = await client.callTool({
    name: "search_papers",
    arguments: { query: "attention", limit: 2 },
  });
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.candidates.length, 1);
  assert.equal(payload.candidates[0].title, SAMPLE_CANDIDATE.title);
  assert.deepEqual(recorded.search, { query: "attention", limit: 2 });
});

test("search_papers rejects invalid arguments with InvalidParams", async (t) => {
  const recorded = {};
  const { client } = await startPair(t, makeStubs(recorded));
  const expectInvalid = async (args, pattern) => {
    await assert.rejects(
      client.callTool({ name: "search_papers", arguments: args }),
      (error) => error.code === ErrorCode.InvalidParams && pattern.test(error.message),
    );
  };
  await expectInvalid({}, /"query" must be a string/);
  await expectInvalid({ query: "" }, /must be between 1 and 200/);
  await expectInvalid({ query: "   " }, /must not be empty/);
  await expectInvalid({ query: "x".repeat(201) }, /must be between 1 and 200/);
  await expectInvalid({ query: "ok", limit: 0 }, /integer between 1 and 20/);
  await expectInvalid({ query: "ok", limit: 21 }, /integer between 1 and 20/);
  assert.deepEqual(recorded.search, undefined);
});

test("search_papers maps unexpected failures to bounded InternalError messages", async (t) => {
  const { client } = await startPair(t, {
    searchPapers: async () => {
      throw new Error("boom ghp_secretTokenValue");
    },
  });
  await assert.rejects(
    client.callTool({ name: "search_papers", arguments: { query: "attention" } }),
    (error) =>
      error.code === ErrorCode.InternalError &&
      /search_papers failed: unexpected upstream error/.test(error.message) &&
      !error.message.includes("ghp_secretTokenValue"),
  );
});

test("download_paper requires an absolute targetDir and returns stub result", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-acq-server-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recorded = {};
  const { client } = await startPair(t, makeStubs(recorded));

  const result = await client.callTool({
    name: "download_paper",
    arguments: { url: "https://example.org/paper.pdf", targetDir: dir },
  });
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.sha256, "a".repeat(64));
  assert.equal(payload.bytes, 12);
  assert.equal(recorded.download.targetDir, dir);
  assert.ok(path.isAbsolute(recorded.download.targetDir));

  await assert.rejects(
    client.callTool({
      name: "download_paper",
      arguments: { url: "https://example.org/paper.pdf", targetDir: "relative/dir" },
    }),
    (error) => error.code === ErrorCode.InvalidParams && /absolute path/.test(error.message),
  );

  const longUrl = "https://example.org/" + "a".repeat(2000);
  await assert.rejects(
    client.callTool({
      name: "download_paper",
      arguments: { url: longUrl, targetDir: dir },
    }),
    (error) => error.code === ErrorCode.InvalidParams && /between 1 and 2000/.test(error.message),
  );
});

test("search_repositories defaults to limit 5 and rejects keyword-less titles", async (t) => {
  const recorded = {};
  const { client } = await startPair(t, makeStubs(recorded));

  const result = await client.callTool({
    name: "search_repositories",
    arguments: { title: "Graph Neural Networks for Molecule Prediction" },
  });
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.repositories.length, 1);
  assert.equal(payload.repositories[0].fullName, SAMPLE_REPOSITORY.fullName);
  assert.equal(payload.repositories[0].matchBasis, SAMPLE_REPOSITORY.matchBasis);
  assert.deepEqual(recorded.repos, {
    title: "Graph Neural Networks for Molecule Prediction",
    limit: 5,
  });

  await assert.rejects(
    client.callTool({
      name: "search_repositories",
      arguments: { title: "ab cd ef" },
    }),
    (error) => error.code === ErrorCode.InvalidParams && /4 or more characters/.test(error.message),
  );
  assert.deepEqual(recorded.repos, {
    title: "Graph Neural Networks for Molecule Prediction",
    limit: 5,
  });
});

test("unknown tools yield MethodNotFound", async (t) => {
  const { client } = await startPair(t, makeStubs({}));
  await assert.rejects(
    client.callTool({ name: "no_such_tool", arguments: {} }),
    (error) => error.code === ErrorCode.MethodNotFound && /unknown tool/.test(error.message),
  );
});

test("githubSearchQuery derives bounded keyword queries from a title", () => {
  assert.equal(
    githubSearchQuery("Graph Neural Networks for Molecule Prediction"),
    "Graph+Neural+Networks+Molecule+Prediction",
  );
  assert.equal(githubSearchQuery("aaa bbbb cccc dddd eeee ffff"), "bbbb+cccc+dddd+eeee+ffff");
  assert.throws(
    () => githubSearchQuery("ab cd"),
    (error) => error.code === ErrorCode.InvalidParams,
  );
});
