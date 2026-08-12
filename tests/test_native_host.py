from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("reddit_rpa_native_host", ROOT / "native-host" / "reddit_rpa_native_host.py")
assert SPEC and SPEC.loader
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)


class NativeHostTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "VR-XR"
        (self.root / "raw").mkdir(parents=True)
        rules = self.root / "rules"
        rules.mkdir()
        (rules / "subreddit_registry.json").write_text(json.dumps({
            "collection": {"collectionId": "vr-xr", "name": "VR-XR", "kind": "collection"},
            "subreddits": [{"subreddit": "SteamVR", "canonicalName": "steamvr", "slug": "steamvr", "category": "xr", "historicNames": [], "status": "active"}],
        }), encoding="utf-8")
        self.store = HOST.CollectionStore(self.root)
        self.context = {"subreddit": "SteamVR", "post_fullname": "t3_abc123", "canonical_url": "https://www.reddit.com/r/SteamVR/comments/abc123/post/"}
        self.post = {"record_type": "post", "fullname": "t3_abc123", "post_fullname": "t3_abc123", "post_id": "abc123", "subreddit": "SteamVR", "title": "Post", "canonical_url": self.context["canonical_url"]}

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_writes_a_validated_thread_and_capture_inside_the_fixed_root(self) -> None:
        sync = self.store.handle("sync_posts", {"context": self.context, "records": [self.post], "capturedAt": "2026-08-11T00:00:00.000Z"})
        comment = {
            "record_type": "comment", "fullname": "t1_def456", "post_fullname": "t3_abc123", "parent_fullname": "t3_abc123",
            "ownership_verified": True, "content": "Visible", "published_at": "2026-08-11T00:01:00.000Z",
        }
        stored = self.store.handle("store_thread", {
            "context": self.context, "records": [self.post, comment],
            "capture": {"capture_id": "capture", "captured_at": "2026-08-11T00:01:00.000Z", "status": "complete", "tree_diagnostics": {"deleted_placeholder_count": 1, "reason_codes": ["DELETED_ANCESTOR_OBSERVED"]}},
        })
        directory = self.root / "raw" / "steamvr" / "abc123--post"
        capture = json.loads((directory / "captures.jsonl").read_text(encoding="utf-8"))
        thread = json.loads((directory / "thread.json").read_text(encoding="utf-8"))

        self.assertTrue(sync["ok"])
        self.assertTrue(stored["ok"])
        self.assertEqual(stored["new_comment_count"], 1)
        self.assertEqual(capture["tree_diagnostics"]["deleted_placeholder_count"], 1)
        self.assertEqual(thread["comments"][0]["fullname"], "t1_def456")
        self.assertFalse((self.root / "raw-v2").exists())

    def test_claims_one_targeted_control_request_and_preserves_structured_error_responses(self) -> None:
        collector_id = "collector-p8"
        heartbeat = self.store.handle("write_collector_heartbeat", {
            "collector_id": collector_id, "version": "0.8.0", "state": "ready",
            "work_tab_id": 19, "work_url": "https://www.reddit.com/r/SteamVR/new/",
        })
        request_path = self.root / HOST.CONTROL_DIRECTORY / "requests" / "request-1.json"
        request_path.parent.mkdir(parents=True)
        request_path.write_text(json.dumps({
            "schema": HOST.REQUEST_SCHEMA, "request_id": "request-1", "command": "run", "created_at": "2026-08-11T00:00:00.000Z", "collector_id": collector_id, "subreddit": "SteamVR", "count": 5,
        }), encoding="utf-8")

        pending = self.store.handle("next_control_request", {"collector_id": collector_id})
        other = self.store.handle("next_control_request", {"collector_id": "collector-other"})
        written = self.store.handle("write_control_response", {"request": pending["request"], "result": {"ok": False, "code": "WORK_PAGE_REQUIRED", "error": "工作页不可用"}})
        response_path = self.root / HOST.CONTROL_DIRECTORY / "responses" / "request-1.json"

        self.assertTrue(heartbeat["ok"])
        self.assertEqual(pending["request"]["subreddit"], "SteamVR")
        self.assertEqual(pending["request"]["collector_id"], collector_id)
        self.assertEqual(other["status"], "control_idle")
        self.assertFalse(written["ok"])
        self.assertEqual(json.loads(response_path.read_text(encoding="utf-8"))["code"], "WORK_PAGE_REQUIRED")
        self.assertFalse((self.root / HOST.CONTROL_DIRECTORY / "claims" / "request-1.json").exists())

    def test_lists_only_active_raw_posts(self) -> None:
        self.store.handle("sync_posts", {"context": self.context, "records": [self.post], "capturedAt": "2026-08-11T00:00:00.000Z"})
        frozen = self.root / "frozen" / "raw-v1-2026-08-11" / "steamvr" / "def456--frozen"
        frozen.mkdir(parents=True)
        (frozen / "post.json").write_text(json.dumps({"post": {
            "fullname": "t3_def456", "subreddit": "SteamVR", "title": "Frozen", "canonical_url": "https://www.reddit.com/r/SteamVR/comments/def456/frozen/",
        }}), encoding="utf-8")

        known = self.store.handle("list_known_posts", {"context": self.context})

        self.assertEqual([item["post"]["fullname"] for item in known["posts"]], ["t3_abc123"])
        self.assertEqual([item["layer"] for item in known["posts"]], ["raw"])

    def test_rejects_unlisted_native_operations(self) -> None:
        with self.assertRaises(HOST.HostError) as raised:
            self.store.handle("write_arbitrary_path", {"path": "/tmp/nope"})
        self.assertEqual(raised.exception.code, "NATIVE_OPERATION_INVALID")


if __name__ == "__main__":
    unittest.main()
