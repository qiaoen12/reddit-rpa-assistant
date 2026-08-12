from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from reddit_rpa_control import (  # noqa: E402
    CONTROL_DIRECTORY,
    ControlError,
    batch_status,
    control_health,
    make_request,
    parser,
    submit_request,
    tail_events,
    validate_request,
    verify_batch,
)
from reddit_rpa_mcp import handle  # noqa: E402


class RedditRpaControlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "VR-XR"
        (self.root / "rules").mkdir(parents=True)
        (self.root / "rules" / "subreddit_registry.json").write_text(json.dumps({
            "schemaVersion": 1,
            "subreddits": [{"subreddit": "SteamVR", "canonicalName": "steamvr", "slug": "steamvr", "status": "active"}],
        }), encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_batch(self, targets: list[dict]) -> str:
        batch_id = "2026-08-10_120000_001"
        directory = self.root / "raw" / "batches"
        directory.mkdir(parents=True)
        (directory / f"{batch_id}.json").write_text(json.dumps({
            "schema": "reddit-rpa-batch-v1",
            "batch_id": batch_id,
            "subreddit": "SteamVR",
            "active": False,
            "paused": False,
            "cancelled": False,
            "selected_count": len(targets),
            "targets": targets,
        }), encoding="utf-8")
        return batch_id

    def write_post(self, directory_name: str, post_fullname: str, comments: list[dict], gap: int = 0) -> None:
        directory = self.root / "raw" / "steamvr" / directory_name
        directory.mkdir(parents=True)
        (directory / "post.json").write_text(json.dumps({"post": {"fullname": post_fullname}}), encoding="utf-8")
        (directory / "comments.jsonl").write_text("".join(json.dumps(item) + "\n" for item in comments), encoding="utf-8")
        (directory / "captures.jsonl").write_text(json.dumps({"comment_count_gap": gap}) + "\n", encoding="utf-8")

    def write_collector(self, collector_id: str = "collector-p8") -> None:
        directory = self.root / CONTROL_DIRECTORY / "collectors"
        directory.mkdir(parents=True)
        (directory / f"{collector_id}.json").write_text(json.dumps({
            "schema": "reddit-rpa-collector-v1",
            "collector_id": collector_id,
            "backend": "native",
            "seen_at": "2030-08-11T00:00:00.000Z",
            "state": "ready",
        }), encoding="utf-8")

    def test_request_fails_before_writing_when_native_host_is_not_online(self) -> None:
        request = make_request("run", subreddit="SteamVR", count=5)
        result = submit_request(self.root, request, timeout_seconds=0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "NATIVE_HOST_REQUIRED")
        request_path = self.root / CONTROL_DIRECTORY / "requests" / f"{request['request_id']}.json"
        self.assertFalse(request_path.exists())
        self.assertFalse((self.root / "raw").exists(), "the CLI must not create or modify collector output")

    def test_online_collector_is_selected_before_the_control_request_is_written(self) -> None:
        self.write_collector()
        request = make_request("run", subreddit="SteamVR", count=5)
        result = submit_request(self.root, request, timeout_seconds=0)
        request_path = self.root / CONTROL_DIRECTORY / "requests" / f"{request['request_id']}.json"

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "COLLECTOR_UNRESPONSIVE")
        self.assertEqual(json.loads(request_path.read_text(encoding="utf-8"))["collector_id"], "collector-p8")
        self.assertEqual(control_health(self.root)["collector"]["collector_id"], "collector-p8")

    def test_validation_rejects_unknown_subreddit_and_bad_count(self) -> None:
        with self.assertRaises(ControlError):
            validate_request(self.root, make_request("run", subreddit="not_registered", count=5))
        with self.assertRaises(ControlError):
            validate_request(self.root, make_request("run", subreddit="SteamVR", count=51))

    def test_run_request_accepts_only_an_explicit_boolean_skip_existing_flag(self) -> None:
        request = validate_request(self.root, make_request("run", subreddit="SteamVR", count=5, skip_existing=True))

        self.assertTrue(request["skip_existing"])
        self.assertFalse(validate_request(self.root, make_request("run", subreddit="SteamVR", count=5))["skip_existing"])
        with self.assertRaises(ControlError):
            validate_request(self.root, make_request("run", subreddit="SteamVR", count=5, skip_existing="true"))

    def test_cli_parses_the_documented_supplement_run_syntax(self) -> None:
        args = parser().parse_args([
            "--root", str(self.root), "--timeout", "60", "run",
            "--subreddit", "SteamVR", "--count", "25", "--skip-existing",
        ])

        self.assertEqual(args.command, "run")
        self.assertEqual(args.root, self.root)
        self.assertEqual(args.timeout, 60)
        self.assertEqual(args.subreddit, "SteamVR")
        self.assertEqual(args.count, 25)
        self.assertTrue(args.skip_existing)

    def test_cli_parses_exact_unfinished_recovery_syntax(self) -> None:
        args = parser().parse_args([
            "--root", str(self.root), "--timeout", "60", "retry-unfinished",
            "--batch", "2026-08-12_010000_001",
        ])

        self.assertEqual(args.command, "retry_unfinished")
        self.assertEqual(args.source_batch_id, "2026-08-12_010000_001")

    def test_read_only_status_tail_and_verify_report_integrity_issues(self) -> None:
        batch_id = self.write_batch([
            {"fullname": "t3_a", "status": "complete"},
            {"fullname": "t3_b", "status": "tree_partial"},
        ])
        shared = {
            "record_type": "comment", "fullname": "t1_same", "post_fullname": "t3_a", "parent_fullname": "t1_same"
        }
        self.write_post("a", "t3_a", [shared], gap=1)
        self.write_post("b", "t3_b", [{**shared, "parent_fullname": "t3_a"}])
        event_path = self.root / "raw" / "batches" / f"{batch_id}.events.jsonl"
        event_path.write_text(json.dumps({"event": "batch_started", "batch_id": batch_id}) + "\n", encoding="utf-8")

        status = batch_status(self.root, batch_id)
        verification = verify_batch(self.root, batch_id)
        events = tail_events(self.root, batch_id)

        self.assertTrue(status["ok"])
        self.assertEqual(status["target_status_counts"], {"complete": 1, "tree_partial": 1})
        self.assertFalse(verification["ok"])
        self.assertEqual(verification["duplicate_comment_count"], 1)
        self.assertEqual(verification["self_parent_count"], 1)
        self.assertEqual(verification["mismatched_post_count"], 1)
        self.assertEqual(verification["latest_capture_gap_count"], 1)
        self.assertEqual(events["event_count"], 1)

    def test_verify_separates_structural_integrity_from_recovery_need(self) -> None:
        batch_id = self.write_batch([
            {"fullname": "t3_a", "status": "complete"},
            {"fullname": "t3_b", "status": "interrupted"},
        ])

        verification = verify_batch(self.root, batch_id)

        self.assertTrue(verification["structural_integrity_ok"])
        self.assertFalse(verification["ok"], "an interrupted target must not look collection-complete")
        self.assertTrue(verification["all_targets_terminal"], "interrupted remains terminal for historical audit")
        self.assertEqual(verification["recovery_target_count"], 1)
        self.assertFalse(verification["collection_complete"])

    def test_mcp_exposes_tools_and_reuses_the_read_only_status_path(self) -> None:
        batch_id = self.write_batch([{"fullname": "t3_a", "status": "complete"}])
        listed = handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        called = handle({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "reddit_rpa_status", "arguments": {"root": str(self.root), "batch_id": batch_id}},
        })
        self.assertEqual(listed["result"]["tools"][0]["name"], "reddit_rpa_health")
        self.assertTrue(called["result"]["structuredContent"]["ok"])
        self.assertEqual(called["result"]["structuredContent"]["batch_id"], batch_id)

    def test_mcp_run_exposes_skip_existing(self) -> None:
        listed = handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        run_tool = next(item for item in listed["result"]["tools"] if item["name"] == "reddit_rpa_run")

        self.assertEqual(run_tool["inputSchema"]["properties"]["skip_existing"]["type"], "boolean")

    def test_mcp_exposes_exact_unfinished_recovery(self) -> None:
        listed = handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        recovery_tool = next(item for item in listed["result"]["tools"] if item["name"] == "reddit_rpa_retry_unfinished")

        self.assertEqual(recovery_tool["inputSchema"]["required"], ["source_batch_id"])
