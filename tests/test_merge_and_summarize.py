from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "merge_and_summarize.py"


def post() -> dict[str, object]:
    return {
        "id": "abc123", "fullname": "t3_abc123", "record_type": "post", "subreddit": "VRGaming",
        "post_id": "abc123", "post_fullname": "t3_abc123", "parent_fullname": None, "depth": 0,
        "title": "Post title", "content": "Post body", "author": "poster", "canonical_url": "https://www.reddit.com/r/VRGaming/comments/abc123/post/",
        "captured_at": "2026-08-07T12:00:00.000Z", "published_at": "2026-08-07T12:00:00.000Z", "attachments": [], "categories": []
    }


def comment(content: str) -> dict[str, object]:
    return {
        "id": "def456", "fullname": "t1_def456", "record_type": "comment", "subreddit": "VRGaming",
        "post_id": "abc123", "post_fullname": "t3_abc123", "parent_fullname": "t3_abc123", "depth": 0,
        "title": "", "content": content, "author": "commenter", "canonical_url": "https://www.reddit.com/r/VRGaming/comments/abc123/post/def456/",
        "captured_at": "2026-08-07T12:03:00.000Z", "published_at": "2026-08-07T12:03:00.000Z", "attachments": [], "categories": []
    }


class MergeAndSummarizeTests(unittest.TestCase):
    def test_merges_batch_records_preserves_tree_and_writes_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = {
                "schema": "reddit-rpa-batch-v1",
                "records": [post(), comment("Short"), comment("Longer continuation reply")],
                "quality": {"continuation_urls": ["https://www.reddit.com/r/VRGaming/comments/abc123/post/def456/"], "unexpanded_controls": ["More replies"]}
            }
            (root / "batch_one.json").write_text(json.dumps(payload), encoding="utf-8")
            completed = subprocess.run([sys.executable, str(SCRIPT), "--input", str(root), "--out", str(root)], check=True, capture_output=True, text=True)
            self.assertIn("去重后 2 条 Reddit 记录", completed.stdout)
            merged = [json.loads(line) for line in (root / "reddit_records_merged.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(merged), 2)
            self.assertEqual(merged[1]["content"], "Longer continuation reply")
            self.assertEqual(merged[1]["parent_fullname"], "t3_abc123")
            quality = json.loads((root / "quality_report.json").read_text(encoding="utf-8"))
            self.assertEqual(quality["post_count"], 1)
            self.assertEqual(quality["comment_count"], 1)
            self.assertEqual(quality["unexpanded_controls"], ["More replies"])

            rerun = subprocess.run(
                [sys.executable, str(SCRIPT), "--input", str(root), "--out", str(root)],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(rerun.returncode, 0, rerun.stderr)

            connection = sqlite3.connect(root / "reddit_records.sqlite3")
            try:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM records").fetchone()[0], 2)
            finally:
                connection.close()
            self.assertIn("2026-08-07,1,1,2", (root / "daily_summary.csv").read_text(encoding="utf-8-sig"))

    def test_prefixes_all_derived_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "batch_one.json").write_text(json.dumps({"schema": "reddit-rpa-batch-v1", "records": [post()]}), encoding="utf-8")
            subprocess.run([sys.executable, str(SCRIPT), "--input", str(root), "--out", str(root), "--prefix", "2026-08-07_120000_000"], check=True)
            expected = {
                "batch_one.json", "2026-08-07_120000_000_reddit_records_merged.jsonl", "2026-08-07_120000_000_reddit_records.sqlite3",
                "2026-08-07_120000_000_daily_summary.csv", "2026-08-07_120000_000_subreddit_summary.csv",
                "2026-08-07_120000_000_quality_report.json", "2026-08-07_120000_000_summary.md"
            }
            self.assertEqual({path.name for path in root.iterdir()}, expected)

    def test_recursively_merges_post_thread_documents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            thread_path = root / "raw" / "vrgaming" / "abc123--post_title" / "thread.json"
            thread_path.parent.mkdir(parents=True)
            thread_path.write_text(json.dumps({
                "schema": "reddit-rpa-thread-v1",
                "capture_count": 2,
                "post": post(),
                "comments": [comment("Stored comment")],
                "latest_capture": {
                    "status": "completed",
                    "quality": {"continuation_urls": [], "unexpanded_controls": ["查看更多评论"]}
                }
            }), encoding="utf-8")
            output = root / "clean" / "vrgaming"
            completed = subprocess.run(
                [sys.executable, str(SCRIPT), "--input", str(root / "raw" / "vrgaming"), "--out", str(output)],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertIn("去重后 2 条 Reddit 记录", completed.stdout)
            merged = [json.loads(line) for line in (output / "reddit_records_merged.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual([row["fullname"] for row in merged], ["t3_abc123", "t1_def456"])
            quality = json.loads((output / "quality_report.json").read_text(encoding="utf-8"))
            self.assertEqual(quality["input_thread_count"], 1)
            self.assertEqual(quality["input_legacy_batch_count"], 0)
            self.assertEqual(quality["unexpanded_controls"], ["查看更多评论"])
