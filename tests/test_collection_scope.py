from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("collection_scope", ROOT / "scripts" / "verify_collection_scope.py")
assert SPEC and SPEC.loader
SCOPE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCOPE)


class CollectionScopeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "VR-XR"
        self.scope_path = self.root / "rules" / "scope.json"
        self.scope_path.parent.mkdir(parents=True)
        self.scope_path.write_text(json.dumps({
            "scope_id": "test", "default_target_count": 1, "approved_batch_ids": ["batch-1"],
            "approved_short_lists": [], "excluded_subreddits": [],
        }), encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_checks_only_approved_batch_targets(self) -> None:
        batches = self.root / "raw" / "batches"
        batches.mkdir(parents=True)
        (batches / "batch-1.json").write_text(json.dumps({
            "batch_id": "batch-1", "subreddit": "SteamVR", "active": False,
            "targets": [{"fullname": "t3_post", "status": "complete"}],
        }), encoding="utf-8")
        post_directory = self.root / "raw" / "steamvr" / "post--title"
        post_directory.mkdir(parents=True)
        (post_directory / "post.json").write_text(json.dumps({"post": {"fullname": "t3_post", "subreddit": "SteamVR"}}), encoding="utf-8")
        (post_directory / "comments.jsonl").write_text(json.dumps({"record_type": "comment", "fullname": "t1_comment", "post_fullname": "t3_post", "parent_fullname": "t3_post"}) + "\n", encoding="utf-8")
        (post_directory / "captures.jsonl").write_text(json.dumps({"status": "complete"}) + "\n", encoding="utf-8")
        historical = self.root / "raw" / "other" / "old"
        historical.mkdir(parents=True)
        (historical / "post.json").write_text(json.dumps({"post": {"fullname": "t3_old", "subreddit": "other"}}), encoding="utf-8")
        (historical / "comments.jsonl").write_text(json.dumps({"record_type": "comment", "fullname": "t1_comment", "post_fullname": "t3_old", "parent_fullname": "t1_comment"}) + "\n", encoding="utf-8")

        result = SCOPE.verify_scope(self.root, self.scope_path)

        self.assertTrue(result["ok"])
        self.assertEqual(result["checked_comment_count"], 1)
        self.assertEqual(result["duplicate_comment_count"], 0)


if __name__ == "__main__":
    unittest.main()
