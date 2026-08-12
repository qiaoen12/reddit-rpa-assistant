from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("comment_tree_review_queue", ROOT / "scripts" / "build_comment_tree_review_queue.py")
assert SPEC and SPEC.loader
QUEUE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(QUEUE)


class CommentTreeReviewQueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "VR-XR"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_capture(self, directory_name: str, capture: dict) -> None:
        directory = self.root / "raw" / "steamvr" / directory_name
        directory.mkdir(parents=True)
        (directory / "post.json").write_text(json.dumps({"post": {
            "fullname": f"t3_{directory_name}",
            "canonical_url": f"https://www.reddit.com/r/SteamVR/comments/{directory_name}/post/",
        }}), encoding="utf-8")
        (directory / "captures.jsonl").write_text(json.dumps(capture) + "\n", encoding="utf-8")

    def test_builds_deduplicated_actionable_queue_without_touching_raw(self) -> None:
        self.write_capture("manual", {
            "status": "manual", "coverage_status": "retry", "reported_comment_count": 5,
            "collected_comment_count": 0, "comment_count_gap": 5, "quality": {"unknown_parent_comment": 0},
        })
        self.write_capture("partial", {
            "status": "tree_partial", "coverage_status": "tree_partial", "reported_comment_count": 2,
            "collected_comment_count": 2, "comment_count_gap": 0, "quality": {"unknown_parent_comment": 1},
            "tree_diagnostics": {"reason_codes": ["DELETED_ANCESTOR_OBSERVED"]},
        })
        self.write_capture("gap", {
            "status": "complete", "coverage_status": "complete_with_reported_count_gap", "reported_comment_count": 3,
            "collected_comment_count": 2, "comment_count_gap": 1, "quality": {"unknown_parent_comment": 0},
        })
        self.write_capture("complete", {
            "status": "complete", "coverage_status": "complete", "reported_comment_count": 1,
            "collected_comment_count": 1, "comment_count_gap": 0, "quality": {"unknown_parent_comment": 0},
        })

        output = self.root / "insights" / "quality"
        result = QUEUE.build_queue(self.root, output, "2026-08-11")
        rows = [json.loads(line) for line in Path(result["jsonl_path"]).read_text(encoding="utf-8").splitlines()]

        self.assertEqual(result["item_count"], 3)
        self.assertEqual([row["level"] for row in rows], ["high", "normal", "low"])
        self.assertEqual(result["categories"], {
            "manual": 1,
            "tree_partial": 1,
            "failed": 0,
            "complete_with_reported_count_gap": 1,
        })
        self.assertIn("REPORTED_NONZERO_COLLECTED_ZERO", rows[0]["reason_codes"])
        self.assertIn("DELETED_ANCESTOR_OBSERVED", rows[1]["reason_codes"])
        self.assertEqual(rows[2]["coverage_status"], "complete_with_reported_count_gap")
        markdown = Path(result["markdown_path"]).read_text(encoding="utf-8")
        self.assertIn("`complete_with_reported_count_gap` 1", markdown)
        self.assertTrue((self.root / "raw").is_dir())
        self.assertFalse((self.root / "raw-v2").exists())


if __name__ == "__main__":
    unittest.main()
