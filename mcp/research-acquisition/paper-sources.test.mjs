import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateCandidates,
  parseArxivFeed,
  ResearchSourceError,
  searchArxiv,
  searchOpenAlex,
} from "./paper-sources.ts";

const ATOM = "application/atom+xml";
const JSON_TYPE = "application/json";

function xmlResponse(xml) {
  return new Response(xml, { status: 200, headers: { "content-type": ATOM } });
}

function jsonResponse(text) {
  return new Response(text, { status: 200, headers: { "content-type": JSON_TYPE } });
}

const noNetwork = async () => {
  throw new Error("test accidentally touched the network");
};

const ARXIV_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>Attention Is All You Need: A Study</title>
    <published>2024-01-15T10:00:00Z</published>
    <author><name>Anna Alpha</name></author>
    <author><name>Ben &amp; Beta</name></author>
    <summary>We study attention mechanisms
      across many tasks.</summary>
    <link href="http://arxiv.org/abs/2401.12345v1" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/2401.12345v1" title="pdf" rel="related" type="application/pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2306.99999</id>
    <title>No Pdf Link Here</title>
    <published>2023-06-01T00:00:00Z</published>
    <author><name>Casey Count</name></author>
    <summary>Short summary.</summary>
  </entry>
</feed>`;

const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"></feed>`;

const OPENALEX_PAYLOAD = JSON.stringify({
  results: [
    {
      id: "https://openalex.org/W123456",
      title: "A Transformer Study",
      publication_year: 2023,
      doi: "https://doi.org/10.48550/arXiv.1706.03762",
      authorships: [{ author: { display_name: "Nina Nguyen" } }, { author: { display_name: "Omar Osei" } }],
      best_oa_location: { pdf_url: "https://example.org/paper.pdf" },
      open_access: { is_oa: true },
    },
    {
      id: "https://openalex.org/W222222",
      title: "Open Access But No Pdf",
      open_access: { is_oa: true },
      best_oa_location: { pdf_url: null },
    },
    {
      id: "https://openalex.org/W333333",
      title: "Closed Access With Pdf",
      open_access: { is_oa: false },
      best_oa_location: { pdf_url: "https://example.org/closed.pdf" },
    },
  ],
});

const OA_ONE_TITLE_DUP = JSON.stringify({
  results: [
    {
      id: "https://openalex.org/W444444",
      title: "Attention is all you need!",
      publication_year: 2017,
      doi: "https://doi.org/10.5555/fake.doi",
      best_oa_location: { pdf_url: "https://example.org/dup.pdf" },
      open_access: { is_oa: true },
    },
  ],
});

const OA_DOI_DUP = JSON.stringify({
  results: [
    {
      id: "https://openalex.org/W100001",
      title: "Graph Nets Version A",
      publication_year: 2022,
      doi: "https://doi.org/10.1016/j.fake.2023.01.001",
      best_oa_location: { pdf_url: "https://example.org/a.pdf" },
      open_access: { is_oa: true },
    },
    {
      id: "https://openalex.org/W100002",
      title: "Graph Nets Version B",
      publication_year: 2022,
      doi: "10.1016/j.FAKE.2023.01.001",
      best_oa_location: { pdf_url: "https://example.org/b.pdf" },
      open_access: { is_oa: true },
    },
  ],
});

const ARXIV_SINGLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001</id>
    <title>Attention Is All You Need</title>
    <published>2024-01-01T00:00:00Z</published>
    <summary>An attention based architecture.</summary>
  </entry>
</feed>`;

const ARXIV_ID_DUP = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.11111</id>
    <title>Duplicate Paper</title>
    <published>2024-02-01T00:00:00Z</published>
    <summary>First copy.</summary>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.11111</id>
    <title>Duplicate Paper Again</title>
    <published>2024-02-01T00:00:00Z</published>
    <summary>Second copy.</summary>
  </entry>
</feed>`;

const ARXIV_TWO_YEARS = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.22222</id>
    <title>Newer Paper</title>
    <published>2024-03-01T00:00:00Z</published>
    <summary>Newer.</summary>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2201.22222</id>
    <title>Older Paper</title>
    <published>2022-03-01T00:00:00Z</published>
    <summary>Older.</summary>
  </entry>
</feed>`;

test("searchArxiv parses an Atom fixture and requests the expected query url", async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    return xmlResponse(ARXIV_XML);
  };

  const candidates = await searchArxiv("attention mechanisms", { limit: 2, fetchFn });

  assert.equal(candidates.length, 2);
  const first = candidates[0];
  assert.equal(first.id, "2401.12345v1");
  assert.equal(first.source, "arxiv");
  assert.equal(first.title, "Attention Is All You Need: A Study");
  assert.deepEqual(first.authors, ["Anna Alpha", "Ben & Beta"]);
  assert.equal(first.year, 2024);
  assert.equal(first.venue, null);
  assert.equal(first.pdfUrl, "https://arxiv.org/pdf/2401.12345v1");
  assert.equal(first.abstract, "We study attention mechanisms across many tasks.");
  assert.equal(first.identifiers.arxiv, "2401.12345v1");
  assert.equal(candidates[1].pdfUrl, "https://arxiv.org/pdf/2306.99999");

  assert.equal(urls.length, 1);
  assert.ok(urls[0].startsWith("https://export.arxiv.org/api/query?search_query="));
  assert.ok(urls[0].includes("search_query=" + encodeURIComponent("all:attention mechanisms")));
  assert.ok(urls[0].includes("start=0"));
  assert.ok(urls[0].includes("max_results=2"));
});

test("searchArxiv rejects malformed feeds and invalid query/limit arguments", async () => {
  assert.throws(
    () => parseArxivFeed("<html><body>rate limited</body></html>"),
    (error) => error instanceof ResearchSourceError && /invalid arxiv response/.test(error.message),
  );
  await assert.rejects(searchArxiv("   ", { fetchFn: noNetwork }), /query must be a non-empty string/);
  await assert.rejects(
    searchArxiv("attention", { limit: 0, fetchFn: noNetwork }),
    /limit must be an integer between 1 and 20/,
  );
  await assert.rejects(
    searchArxiv("attention", { limit: 21, fetchFn: noNetwork }),
    /limit must be an integer between 1 and 20/,
  );
  await assert.rejects(searchArxiv("x".repeat(201), { fetchFn: noNetwork }), /query must not exceed 200 characters/);
});

test("searchOpenAlex keeps only records that are open-access with a pdf url", async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    return jsonResponse(OPENALEX_PAYLOAD);
  };

  const candidates = await searchOpenAlex("transformers", { limit: 5, fetchFn });

  assert.equal(candidates.length, 1);
  const only = candidates[0];
  assert.equal(only.id, "W123456");
  assert.equal(only.source, "openalex");
  assert.deepEqual(only.authors, ["Nina Nguyen", "Omar Osei"]);
  assert.equal(only.year, 2023);
  assert.equal(only.pdfUrl, "https://example.org/paper.pdf");
  assert.equal(only.abstract, null);
  assert.equal(only.identifiers.doi, "10.48550/arXiv.1706.03762");
  assert.equal(only.identifiers.openalex, "W123456");

  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes("search=" + encodeURIComponent("transformers")));
  assert.ok(urls[0].includes("per-page=5"));
});

test("searchOpenAlex rejects a malformed json body", async () => {
  const fetchFn = async () => jsonResponse("this is not json");
  await assert.rejects(searchOpenAlex("transformers", { fetchFn }), /invalid openalex response/);
});

test("aggregateCandidates deduplicates the same paper by normalized title across sources", async () => {
  const fetchFn = async (url) => {
    if (url.includes("export.arxiv.org")) {
      return xmlResponse(ARXIV_SINGLE);
    }
    if (url.includes("api.openalex.org")) {
      return jsonResponse(OA_ONE_TITLE_DUP);
    }
    throw new Error("unexpected url " + url);
  };

  const candidates = await aggregateCandidates("attention is all you need", { limit: 5, fetchFn });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, "arxiv");
  assert.equal(candidates[0].id, "2401.00001");
  assert.equal(candidates[0].title, "Attention Is All You Need");
});

test("aggregateCandidates deduplicates by DOI and by arXiv id", async () => {
  const doiDupFetch = async (url) => {
    if (url.includes("export.arxiv.org")) {
      return xmlResponse(EMPTY_FEED);
    }
    if (url.includes("api.openalex.org")) {
      return jsonResponse(OA_DOI_DUP);
    }
    throw new Error("unexpected url " + url);
  };
  const byDoi = await aggregateCandidates("graph neural networks", { limit: 5, fetchFn: doiDupFetch });
  assert.equal(byDoi.length, 1);
  assert.equal(byDoi[0].source, "openalex");
  assert.equal(byDoi[0].id, "W100001");
  assert.equal(byDoi[0].identifiers.doi, "10.1016/j.fake.2023.01.001");

  const idDupFetch = async (url) => {
    if (url.includes("export.arxiv.org")) {
      return xmlResponse(ARXIV_ID_DUP);
    }
    throw new Error("openalex is unavailable");
  };
  const byArxivId = await aggregateCandidates("duplicate", { limit: 5, fetchFn: idDupFetch });
  assert.equal(byArxivId.length, 1);
  assert.equal(byArxivId[0].id, "2401.11111");
});

test("aggregateCandidates sorts, caps, tolerates a failing source and reports total failure", async () => {
  const arxivOnly = async (url) => {
    if (url.includes("export.arxiv.org")) {
      return xmlResponse(ARXIV_TWO_YEARS);
    }
    throw new Error("openalex is down");
  };
  const newest = await aggregateCandidates("two papers", { limit: 1, fetchFn: arxivOnly });
  assert.equal(newest.length, 1);
  assert.equal(newest[0].year, 2024);

  const allDown = async () => {
    throw new Error("network unreachable");
  };
  await assert.rejects(
    aggregateCandidates("nothing", { fetchFn: allDown }),
    (error) =>
      error instanceof ResearchSourceError &&
      error.source === "aggregate" &&
      /no results from any source/.test(error.message),
  );
});
