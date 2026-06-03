from dataclasses import dataclass


@dataclass(frozen=True)
class PaperChunk:
    paper_id: str
    chunk_id: str
    page: int
    text: str

    @classmethod
    def from_dict(cls, value: dict) -> "PaperChunk":
        return cls(str(value["paperId"]), str(value["chunkId"]), int(value["page"]), str(value["text"]))

    def to_dict(self) -> dict:
        return {"paperId": self.paper_id, "chunkId": self.chunk_id, "page": self.page, "text": self.text}
