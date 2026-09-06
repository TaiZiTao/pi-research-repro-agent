import re
from rank_bm25 import BM25Okapi
from .models import PaperChunk

TOKEN_PATTERN = re.compile(r"[a-z0-9]+|[\u3400-\u9fff]", re.IGNORECASE)


def tokenize(text: str) -> list[str]:
    return [x.lower() for x in TOKEN_PATTERN.findall(text)]


class KeywordStore:
    def __init__(self, chunks: list[PaperChunk]):
        self.chunks = chunks
        corpus = [tokenize(x.text) for x in chunks]
        self.index = BM25Okapi(corpus) if corpus else None

    def search(self, query: str, k: int):
        if self.index is None:
            return []
        query_tokens = tokenize(query)
        scores = self.index.get_scores(query_tokens)
        query_set = set(query_tokens)
        overlap = [len(query_set.intersection(tokens)) for tokens in self.index.doc_freqs]
        order = sorted(
            range(len(scores)),
            key=lambda i: (-float(scores[i]), -overlap[i], self.chunks[i].chunk_id),
        )
        relevant = [i for i in order if float(scores[i]) > 0 or overlap[i] > 0]
        return [(self.chunks[i], float(scores[i])) for i in relevant[:k]]
