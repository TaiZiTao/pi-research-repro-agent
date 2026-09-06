import { type Static, Type } from "typebox";

export const ResearchCitationSchema = Type.Object(
  {
    paperId: Type.String({ minLength: 64, maxLength: 64 }),
    page: Type.Integer({ minimum: 1 }),
    chunkId: Type.String({ minLength: 1, maxLength: 128 }),
    quote: Type.String({ minLength: 8, maxLength: 500 }),
  },
  { additionalProperties: false },
);

export const GroundedAnswerSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("grounded"), Type.Literal("insufficient_evidence")]),
    answer: Type.String({ minLength: 1, maxLength: 6_000 }),
    citations: Type.Array(ResearchCitationSchema, { maxItems: 8 }),
  },
  { additionalProperties: false },
);

export type ResearchCitation = Static<typeof ResearchCitationSchema>;
export type GroundedAnswer = Static<typeof GroundedAnswerSchema>;
