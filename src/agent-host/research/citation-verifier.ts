import type { PaperChunk } from "../../shared/research/types.ts";
import type { GroundedAnswer } from "./answer-schema.ts";

export interface CitationVerification {
  accepted: boolean;
  errors: string[];
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function verifyGroundedAnswer(
  draft: GroundedAnswer,
  chunks: PaperChunk[],
  expectedPaperId: string,
): CitationVerification {
  const errors: string[] = [];
  if (!draft.answer.trim() || draft.answer.length > 6_000) errors.push("answer is outside allowed bounds");
  if (draft.citations.length > 8) errors.push("too many citations");

  if (draft.status === "insufficient_evidence") {
    if (draft.citations.length > 0) errors.push("insufficient-evidence answers must not cite unsupported evidence");
    return { accepted: errors.length === 0, errors };
  }
  if (draft.citations.length === 0) errors.push("grounded answers require at least one citation");

  const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  for (const citation of draft.citations) {
    if (citation.paperId !== expectedPaperId) {
      errors.push(`citation ${citation.chunkId} belongs to another paper`);
      continue;
    }
    const chunk = byId.get(citation.chunkId);
    if (!chunk) {
      errors.push(`citation ${citation.chunkId} does not exist`);
      continue;
    }
    if (chunk.paperId !== expectedPaperId || citation.page !== chunk.page) {
      errors.push(`citation ${citation.chunkId} has an invalid page`);
    }
    const quote = normalize(citation.quote);
    if (quote.length < 8 || !normalize(chunk.text).includes(quote)) {
      errors.push(`citation ${citation.chunkId} quote is not present in the evidence`);
    }
  }
  return { accepted: errors.length === 0, errors };
}
