from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "migrate_runs_to_post_folders.py"


def legacy_thread() -> dict[str, object]:
    post = {
        "id": "abc123", "fullname": "t3_abc123", "record_type": "post", "post_id": "abc123",
        "post_fullname": "t3_abc123", "subreddit": "VRGaming", "title": "Post title", "content": "Post body",
        "canonical_url": "https://www.reddit.com/r/VRGaming/comments/abc123/comment/def456/",
        "source_url_or_raw_path": "https://www.reddit.com/r/VRGaming/comments/abc123/comment/def456/",
        "captured_at": "2026-08-07T12:00:00.000Z",
    }
    comment = {
        "id": "def456", "fullname": "t1_def456", "record_type": "comment", "post_id": "abc123",
        "post_fullname": "t3_abc123", "parent_fullname": "t3_abc123", "depth": 0, "subreddit": "VRGaming",
        "content": "Original comment body", "canonical_url": "https://www.reddit.com/r/VRGaming/comments/abc123/post_title/def456/",
        "captured_at": "2026-08-07T12:00:01.000Z",
    }
    return {
        "schema": "reddit-rpa-batch-v1",
        "generated_at": "2026-08-07T12:03:00.000Z",
        "page": {
            "page_type": "thread", "subreddit": "VRGaming", "post_id": "abc123", "post_fullname": "t3_abc123",
            "canonical_url": "https://www.reddit.com/r/VRGaming/comments/abc123/post_title/",
        },
        "batch": {"batch_id": "legacy-one", "thread_job": {"completed_at": "2026-08-07T12:04:00.000Z"}},
        "quality": {"comment_count": 1, "continuation_urls": [], "unexpanded_controls": []},
        "records": [post, comment],
    }


class MigrateRunsToPostFoldersTests(unittest.TestCase):
    def test_migrates_verified_thread_skips_listing_and_trashes_legacy_runs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "VR-XR"
            thread_source = root / "raw" / "vrgaming" / "runs" / "2026-08-07_120000_000" / "batch_thread.json"
            listing_source = root / "raw" / "vrgaming" / "runs" / "2026-08-07_120100_000" / "batch_listing.json"
            thread_source.parent.mkdir(parents=True)
            listing_source.parent.mkdir(parents=True)
            thread_source.write_text(json.dumps(legacy_thread()), encoding="utf-8")
            listing_source.write_text(json.dumps({"schema": "reddit-rpa-batch-v1", "page": {"page_type": "listing"}, "records": [{"fullname": "t3_x", "record_type": "post"}]}), encoding="utf-8")
            (root / "raw" / "vrgaming" / "runs" / ".DS_Store").write_text("metadata", encoding="utf-8")
            (root / "raw" / "empty" / "runs").mkdir(parents=True)
            report = root / "insights" / "legacy" / "migration.json"
            trash = Path(temporary) / "trash"
            completed = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", str(root), "--apply", "--trash-runs", "--trash-directory", str(trash), "--report", str(report)],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertIn('"migrated": 1', completed.stdout)
            target = root / "raw" / "vrgaming" / "abc123--post_title"
            post = json.loads((target / "post.json").read_text(encoding="utf-8"))
            self.assertEqual(post["post"]["canonical_url"], "https://www.reddit.com/r/VRGaming/comments/abc123/post_title/")
            comments = [json.loads(line) for line in (target / "comments.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual(comments[0]["content"], "Original comment body")
            thread = json.loads((target / "thread.json").read_text(encoding="utf-8"))
            self.assertEqual(thread["comments"][0]["fullname"], "t1_def456")
            audit = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(audit["summary"], {"migrated": 1, "would_migrate": 0, "skipped": 1, "errors": 0})
            self.assertTrue(audit["sources"][0]["status"] in {"migrated", "skipped"})
            self.assertFalse((root / "raw" / "vrgaming" / "runs").exists())
            self.assertFalse((root / "raw" / "empty" / "runs").exists())
            self.assertTrue(any(path.name == "runs" for path in trash.rglob("runs")))

    def test_dry_run_does_not_create_post_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "VR-XR"
            source = root / "raw" / "vrgaming" / "runs" / "legacy" / "batch_thread.json"
            source.parent.mkdir(parents=True)
            source.write_text(json.dumps(legacy_thread()), encoding="utf-8")
            report = Path(temporary) / "report.json"
            subprocess.run([sys.executable, str(SCRIPT), "--root", str(root), "--report", str(report)], check=True)
            payload = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(payload["summary"]["would_migrate"], 1)
            self.assertFalse((root / "raw" / "vrgaming" / "abc123--post_title").exists())
