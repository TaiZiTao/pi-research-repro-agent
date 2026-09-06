import type { EvidenceHit, PaperChunk } from "../../shared/research/types.ts";

const TERM_PATTERN = /[a-z0-9]+|\p{Script=Han}/gu;

function terms(text: string): Set<string> {
  return new Set(text.toLowerCase().match(TERM_PATTERN) ?? []);
}

export function searchEvidence(chunks: PaperChunk[], query: string, limit = 5): EvidenceHit[] {
  const queryTerms = terms(query);
  const boundedLimit = Number.isFinite(limit) ? Math.min(8, Math.max(1, Math.trunc(limit))) : 5;

  return chunks
    .map((chunk) => {
      const chunkTerms = terms(chunk.text);
      let score = 0;
      for (const term of queryTerms) {
        if (chunkTerms.has(term)) score += 1;
      }
      return { ...chunk, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      if (left.page !== right.page) return left.page - right.page;
      if (left.chunkId < right.chunkId) return -1;
      if (left.chunkId > right.chunkId) return 1;
      return 0;
    })
    .slice(0, boundedLimit);
}
