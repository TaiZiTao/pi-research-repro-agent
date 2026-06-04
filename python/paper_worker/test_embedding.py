import unittest
from unittest.mock import patch

from python.paper_worker.rag.embedding import resolve_model_reference


class EmbeddingReferenceTest(unittest.TestCase):
    @patch("huggingface_hub.snapshot_download", return_value=r"C:\cache\models--example\snapshot")
    def test_local_only_hub_model_resolves_to_cached_snapshot(self, snapshot_download):
        resolved = resolve_model_reference("org/model", local_files_only=True)
        self.assertEqual(resolved, r"C:\cache\models--example\snapshot")
        snapshot_download.assert_called_once_with("org/model", local_files_only=True)

    def test_online_model_keeps_hub_identifier(self):
        self.assertEqual(resolve_model_reference("org/model", local_files_only=False), "org/model")

    def test_existing_local_path_is_not_resolved_again(self):
        self.assertEqual(resolve_model_reference(r"C:\models\local", local_files_only=True), r"C:\models\local")


if __name__ == "__main__":
    unittest.main()
