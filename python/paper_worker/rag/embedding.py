from abc import ABC, abstractmethod


class BaseEmbedding(ABC):
    model_name: str
    dimension: int

    @abstractmethod
    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...

    @abstractmethod
    def embed_query(self, text: str) -> list[float]: ...


class SentenceTransformerEmbedding(BaseEmbedding):
    def __init__(self, model_name="intfloat/multilingual-e5-small", local_files_only=True):
        self.model_name = model_name
        self.dimension = 384
        self.local_files_only = local_files_only
        self._model = None

    def _load(self):
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer(self.model_name, local_files_only=self.local_files_only)
            self.dimension = int(self._model.get_embedding_dimension())
        return self._model

    def embed_documents(self, texts):
        return self._load().encode([f"passage: {x}" for x in texts], normalize_embeddings=True).tolist()

    def embed_query(self, text):
        return self._load().encode([f"query: {text}"], normalize_embeddings=True)[0].tolist()
