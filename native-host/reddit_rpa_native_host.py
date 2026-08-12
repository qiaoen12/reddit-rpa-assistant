#!/usr/bin/env python3
"""Chrome Native Messaging Host for the local Reddit RPA collection.

The host owns only the fixed VR-XR collection root. It does not open web pages,
read browser credentials, start an HTTP server, or accept file paths from the
extension. The extension remains the only Reddit DOM collector.
"""

from __future__ import annotations

import json
import os
import re
import struct
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


HOST_NAME = "com.openai.reddit_rpa"
CONTROL_DIRECTORY = ".reddit-rpa-control"
REQUEST_SCHEMA = "reddit-rpa-control-request-v1"
RESPONSE_SCHEMA = "reddit-rpa-control-response-v1"
COLLECTOR_SCHEMA = "reddit-rpa-collector-v1"
OUTPUT_LAYER = "raw"
COMMANDS = {"prepare", "run", "pause", "resume", "cancel"}
CONTROL_CLAIM_LEASE_SECONDS = 90
EVENTS = {
    "batch_started", "post_navigation_started", "page_ready", "capture_saved", "retry", "paused", "resumed",
    "rate_limited", "rate_limit_cooldown_complete", "permission_required", "batch_finished", "cancelled",
}


class HostError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def default_root() -> Path:
    return Path(__file__).resolve().parents[3] / "VR-XR"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def as_text(value: Any) -> str:
    return str(value or "").strip()


def count(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def optional_number(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def valid_identifier(value: Any) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_.-]+", as_text(value)))


def valid_fullname(value: Any, prefix: str) -> str | None:
    raw = as_text(value).lower()
    return raw if re.fullmatch(rf"{prefix}_[a-z0-9]+", raw) else None


def canonical_subreddit(value: Any) -> str | None:
    raw = as_text(value)
    return raw if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_]{1,20}", raw) else None


def json_lines(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        value = json.loads(line)
        if isinstance(value, dict):
            rows.append(value)
    return rows


def write_jsonl(rows: list[dict[str, Any]]) -> str:
    return "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows)


class CollectionStore:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def ensure_root(self) -> None:
        if not (self.root / "raw").is_dir() or not (self.root / "rules" / "subreddit_registry.json").is_file():
            raise HostError("OUTPUT_ROOT_INVALID", "固定 VR-XR 根目录缺少 raw/ 或 rules/subreddit_registry.json。")

    def read_json(self, path: Path, optional: bool = False) -> dict[str, Any] | None:
        if not path.exists():
            if optional:
                return None
            raise HostError("OUTPUT_READ_FAILED", f"文件不存在：{path.relative_to(self.root)}")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise HostError("OUTPUT_JSON_INVALID", f"JSON 无效：{path.relative_to(self.root)}（{error.msg}）") from error
        if not isinstance(value, dict):
            raise HostError("OUTPUT_JSON_INVALID", f"JSON 对象无效：{path.relative_to(self.root)}")
        return value

    def atomic_write(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(text)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def registry_entry(self, context: dict[str, Any], *, allow_register: bool = True) -> dict[str, Any]:
        self.ensure_root()
        subreddit = canonical_subreddit(context.get("subreddit"))
        if not subreddit:
            raise HostError("SUBREDDIT_NAME_UNAVAILABLE", "当前页面没有可用 subreddit，未写入任何文件。")
        registry_path = self.root / "rules" / "subreddit_registry.json"
        registry = self.read_json(registry_path)
        subreddits = registry.get("subreddits") if isinstance(registry, dict) else None
        if not isinstance(subreddits, list):
            raise HostError("SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit 登记表缺少 subreddits 列表。")
        canonical = subreddit.lower()
        for item in subreddits:
            if isinstance(item, dict) and as_text(item.get("canonicalName") or item.get("subreddit")).lower() == canonical:
                return item
        if not allow_register:
            raise HostError("CONTROL_SUBREDDIT_UNKNOWN", "控制命令的 subreddit 不在登记表中，未执行。")
        slug = canonical.replace("_", "-")
        if any(as_text(item.get("slug")) == slug for item in subreddits if isinstance(item, dict)):
            raise HostError("SUBREDDIT_SLUG_CONFLICT", "自动生成的 subreddit 目录名已被占用，未写入任何文件。")
        entry = {
            "subreddit": subreddit,
            "canonicalName": canonical,
            "slug": slug,
            "category": as_text(context.get("category")) or "manual",
            "historicNames": [],
            "status": "active",
        }
        subreddits.append(entry)
        self.atomic_write(registry_path, json.dumps(registry, ensure_ascii=False, indent=2) + "\n")
        return entry

    def post_location(self, context: dict[str, Any], post: dict[str, Any]) -> tuple[dict[str, Any], Path, str, str, str]:
        entry = self.registry_entry(context)
        post_fullname = valid_fullname(post.get("post_fullname") or post.get("fullname"), "t3")
        post_id = as_text(post.get("post_id") or post.get("id") or post_fullname).removeprefix("t3_").lower()
        if not post_fullname or not re.fullmatch(r"[a-z0-9]+", post_id):
            raise HostError("POST_ID_UNAVAILABLE", "帖子代码无效，未写入任何文件。")
        permalink = as_text(post.get("canonical_url") or post.get("source_url") or post.get("source_url_or_raw_path"))
        parsed = urlparse(permalink)
        segments = [segment for segment in parsed.path.split("/") if segment]
        try:
            index = next(index for index, segment in enumerate(segments) if segment.lower() == "comments")
            url_post_id = segments[index + 1].lower()
            raw_slug = segments[index + 2]
        except (StopIteration, IndexError):
            raise HostError("POST_PERMALINK_INVALID", "帖子永久链接无效，未写入任何文件。") from None
        if parsed.scheme != "https" or parsed.hostname not in {"reddit.com", "www.reddit.com"} or url_post_id != post_id or not raw_slug or raw_slug.lower() == "comment":
            raise HostError("POST_PERMALINK_MISMATCH", "帖子永久链接与帖子代码不匹配，未写入任何文件。")
        decoded = unquote(raw_slug).lower()
        slug = re.sub(r"[^a-z0-9]+", "_", decoded).strip("_")[:96]
        if not slug:
            slug = "_".join(f"u{ord(character):x}" for character in decoded)[:96]
        if not slug:
            raise HostError("POST_URL_SLUG_UNAVAILABLE", "帖子永久链接缺少可用标题段，未写入任何文件。")
        subreddit_directory = self.root / OUTPUT_LAYER / as_text(entry.get("slug"))
        preferred = f"{post_id}--{slug}"
        matches = [directory for directory in subreddit_directory.iterdir()] if subreddit_directory.exists() else []
        matches = [directory for directory in matches if directory.is_dir() and directory.name.lower().startswith(f"{post_id}--")]
        if len(matches) > 1:
            raise HostError("POST_DIRECTORY_CONFLICT", f"帖子 {post_id} 对应多个目录，未写入任何文件。")
        directory = matches[0] if matches else subreddit_directory / preferred
        return entry, directory, post_id, slug, f"{OUTPUT_LAYER}/{entry['slug']}/{directory.name}"

    def ensure_post(self, context: dict[str, Any], post: dict[str, Any], captured_at: str) -> tuple[dict[str, Any], Path, str, bool]:
        entry, directory, post_id, slug, relative = self.post_location(context, post)
        path = directory / "post.json"
        existing = self.read_json(path, optional=True)
        if existing and isinstance(existing.get("post"), dict):
            if existing["post"].get("fullname") != post.get("fullname"):
                raise HostError("POST_DIRECTORY_CONFLICT", f"帖子目录 {relative} 的身份与当前帖子不一致，未写入任何文件。")
            return existing, directory, relative, False
        document = {
            "schema": "reddit-rpa-post-v1",
            "created_at": captured_at,
            "directory": {"name": directory.name, "post_id": post_id, "url_slug": slug},
            "post": post,
        }
        self.atomic_write(path, json.dumps(document, ensure_ascii=False, indent=2) + "\n")
        return document, directory, relative, True

    def sync_posts(self, payload: dict[str, Any]) -> dict[str, Any]:
        context = payload.get("context") or {}
        captured_at = as_text(payload.get("capturedAt")) or now()
        created: list[dict[str, Any]] = []
        existing: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        for post in payload.get("records") or []:
            if not isinstance(post, dict) or post.get("record_type") != "post":
                continue
            try:
                _, _, relative, created_now = self.ensure_post(context, post, captured_at)
                item = {"fullname": post.get("fullname"), "title": post.get("title") or "", "relativePath": relative}
                (created if created_now else existing).append(item)
            except HostError as error:
                skipped.append({"fullname": post.get("fullname"), "title": post.get("title") or "", "code": error.code, "error": str(error)})
        return {"ok": True, "status": "posts_synced", "created_count": len(created), "existing_count": len(existing), "skipped_count": len(skipped), "created": created, "existing": existing, "skipped": skipped}

    def comment_snapshot(self, records: list[dict[str, Any]], post_fullname: str) -> list[dict[str, Any]]:
        comments: dict[str, dict[str, Any]] = {}
        for record in records:
            if not isinstance(record, dict) or record.get("record_type") != "comment":
                continue
            fullname = valid_fullname(record.get("fullname"), "t1")
            if not fullname:
                raise HostError("COMMENT_ID_UNAVAILABLE", "评论缺少 t1_* 身份，未写入任何评论。")
            if record.get("post_fullname") != post_fullname:
                raise HostError("COMMENT_POST_MISMATCH", "评论的 post_fullname 与当前帖子不一致，未写入任何评论。")
            if record.get("ownership_verified") is not True:
                raise HostError("COMMENT_OWNERSHIP_UNVERIFIED", "评论缺少当前帖子归属证据，未写入任何评论。")
            if record.get("parent_fullname") == fullname:
                raise HostError("COMMENT_SELF_PARENT", "评论父级不能指向自身，未写入任何评论。")
            comments[fullname] = record
        return sorted(comments.values(), key=lambda item: (as_text(item.get("published_at") or item.get("captured_at")), as_text(item.get("fullname"))))

    def tree_diagnostics(self, value: Any) -> dict[str, Any] | None:
        if not isinstance(value, dict):
            return None
        return {
            "deleted_placeholder_count": count(value.get("deleted_placeholder_count")),
            "removed_placeholder_count": count(value.get("removed_placeholder_count")),
            "collapsed_placeholder_count": count(value.get("collapsed_placeholder_count")),
            "unmapped_native_parent_path_count": count(value.get("unmapped_native_parent_path_count")),
            "reason_codes": list(dict.fromkeys(as_text(code) for code in value.get("reason_codes", []) if as_text(code))),
        }

    def capture_record(self, capture: dict[str, Any], post_fullname: str, *, collected: int, known: int, new: int) -> dict[str, Any]:
        return {
            "schema": "reddit-rpa-thread-capture-v1",
            "capture_id": as_text(capture.get("capture_id")) or now().replace(":", "").replace("-", ""),
            "captured_at": as_text(capture.get("captured_at")) or now(),
            "source_url": as_text(capture.get("source_url")) or None,
            "post_fullname": post_fullname,
            "reported_comment_count": optional_number(capture.get("reported_comment_count")),
            "collected_comment_count": count(collected),
            "known_comment_count": count(known),
            "new_comment_count": count(new),
            "coverage_status": as_text(capture.get("coverage_status")) or as_text(capture.get("status")) or "complete",
            "comment_count_gap": optional_number(capture.get("comment_count_gap")),
            "visible_comment_count": optional_number(capture.get("visible_comment_count")),
            "rejected_foreign_comment_count": count(capture.get("rejected_foreign_comment_count")),
            "settle_wait_ms": count(capture.get("settle_wait_ms")),
            "navigation_jitter_ms": count(capture.get("navigation_jitter_ms")),
            "total_wait_ms": count(capture.get("total_wait_ms")),
            "zero_comment_recheck_count": count(capture.get("zero_comment_recheck_count")),
            "page_events": list(capture.get("page_events") or [])[:50],
            "tree_diagnostics": self.tree_diagnostics(capture.get("tree_diagnostics")),
            "quality": capture.get("quality") if isinstance(capture.get("quality"), dict) else None,
            "status": as_text(capture.get("status")) or "complete",
            "error": as_text(capture.get("error")) or None,
        }

    def write_thread_document(self, directory: Path, post_document: dict[str, Any], comments: list[dict[str, Any]], captures: list[dict[str, Any]], generated_at: str) -> None:
        first = captures[0].get("captured_at") if captures else post_document.get("created_at") or generated_at
        last = captures[-1].get("captured_at") if captures else first
        thread = {
            "schema": "reddit-rpa-thread-v1",
            "generated_at": generated_at,
            "first_captured_at": first,
            "last_captured_at": last,
            "capture_count": len(captures),
            "post": post_document["post"],
            "comments": comments,
            "latest_capture": captures[-1] if captures else None,
            "quality": captures[-1].get("quality") if captures else None,
        }
        self.atomic_write(directory / "thread.json", json.dumps(thread, ensure_ascii=False, indent=2) + "\n")

    def store_thread(self, payload: dict[str, Any]) -> dict[str, Any]:
        context = payload.get("context") or {}
        records = [record for record in payload.get("records") or [] if isinstance(record, dict)]
        post_fullname = valid_fullname(context.get("post_fullname"), "t3")
        post = next((record for record in records if record.get("record_type") == "post" and record.get("fullname") == post_fullname), None)
        if not post:
            raise HostError("THREAD_POST_UNAVAILABLE", "评论树中没有可写入的帖子记录。")
        capture = payload.get("capture") or {}
        captured_at = as_text(capture.get("captured_at")) or now()
        post_document, directory, relative, created = self.ensure_post(context, post, captured_at)
        existing_comments = json_lines(directory / "comments.jsonl")
        comments = self.comment_snapshot(records, post_fullname)
        existing_ids = {as_text(comment.get("fullname")) for comment in existing_comments}
        self.atomic_write(directory / "comments.jsonl", write_jsonl(comments))
        captures = json_lines(directory / "captures.jsonl")
        capture_record = self.capture_record(capture, post_fullname, collected=len(comments), known=len(comments), new=sum(as_text(comment.get("fullname")) not in existing_ids for comment in comments))
        captures.append(capture_record)
        self.atomic_write(directory / "captures.jsonl", write_jsonl(captures))
        self.write_thread_document(directory, post_document, comments, captures, captured_at)
        return {"ok": True, "status": "thread_stored", "relativePath": relative, "post_fullname": post_fullname, "created_post_directory": created, "collected_comment_count": len(comments), "new_comment_count": capture_record["new_comment_count"], "known_comment_count": len(comments), "snapshot_replaced": True, "capture": capture_record}

    def record_thread_failure(self, payload: dict[str, Any]) -> dict[str, Any]:
        context = payload.get("context") or {}
        target = payload.get("target") or {}
        post = target.get("post") if isinstance(target.get("post"), dict) else None
        if not post:
            raise HostError("THREAD_POST_UNAVAILABLE", "失败任务缺少帖子元数据，未写入采集日志。")
        capture = payload.get("capture") or {}
        captured_at = as_text(capture.get("captured_at")) or now()
        post_document, directory, relative, _ = self.ensure_post(context, post, captured_at)
        comments = json_lines(directory / "comments.jsonl")
        captures = json_lines(directory / "captures.jsonl")
        record = self.capture_record(capture, as_text(post.get("fullname")), collected=0, known=len(comments), new=0)
        captures.append(record)
        self.atomic_write(directory / "captures.jsonl", write_jsonl(captures))
        self.write_thread_document(directory, post_document, comments, captures, captured_at)
        return {"ok": True, "status": "thread_failure_recorded", "relativePath": relative, "capture": record}

    def target_summary(self, target: dict[str, Any], status: str) -> dict[str, Any]:
        return {
            "fullname": target.get("fullname") or (target.get("post") or {}).get("fullname"),
            "title": target.get("title") or (target.get("post") or {}).get("title") or "",
            "permalink": target.get("permalink"),
            "attempts": count(target.get("attempts")),
            "rate_limit_failures": count(target.get("rate_limit_failures")),
            "status": status,
            "error": target.get("error") or target.get("last_error"),
            "finished_at": target.get("finished_at"),
        }

    def batch_manifest(self, batch: dict[str, Any]) -> dict[str, Any]:
        cancelled = bool(batch.get("cancelled"))
        targets: list[dict[str, Any]] = []
        targets.extend(self.target_summary(target, "unprocessed" if cancelled else "queued") for target in batch.get("queue") or [])
        if isinstance(batch.get("current"), dict):
            targets.append(self.target_summary(batch["current"], "interrupted" if cancelled else "running"))
        for field, status in (("completed", "complete"), ("tree_partial", "tree_partial"), ("manual", "manual"), ("failed", "failed")):
            targets.extend(self.target_summary(target, status) for target in batch.get(field) or [])
        return {
            "schema": "reddit-rpa-batch-v1",
            "batch_id": as_text(batch.get("batch_id")),
            "subreddit": (batch.get("context") or {}).get("subreddit"),
            "started_at": batch.get("started_at"), "completed_at": batch.get("completed_at"),
            "active": bool(batch.get("active")), "paused": bool(batch.get("paused")), "cancelled": cancelled,
            "cancelled_at": batch.get("cancelled_at"), "cancel_reason": batch.get("cancel_reason"),
            "selected_count": count(batch.get("selected_count")), "selection_mode": batch.get("selection_mode") or "selected",
            "config": batch.get("config") or {}, "rate_limit": batch.get("rate_limit"), "targets": targets,
            "integrity": batch.get("integrity"),
        }

    def store_batch(self, payload: dict[str, Any]) -> dict[str, Any]:
        batch = payload.get("batch") or {}
        batch_id = as_text(batch.get("batch_id"))
        if not valid_identifier(batch_id):
            raise HostError("BATCH_ID_INVALID", "批次 ID 无效，未写入批次清单。")
        self.ensure_root()
        manifest = self.batch_manifest(batch)
        path = self.root / OUTPUT_LAYER / "batches" / f"{batch_id}.json"
        self.atomic_write(path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        return {"ok": True, "status": "batch_manifest_stored", "relativePath": f"{OUTPUT_LAYER}/batches/{batch_id}.json", "manifest": manifest}

    def normalise_event(self, event: dict[str, Any]) -> dict[str, Any]:
        batch_id, event_name = as_text(event.get("batch_id")), as_text(event.get("event"))
        if not valid_identifier(batch_id):
            raise HostError("BATCH_ID_INVALID", "批次事件缺少有效 batch_id，未写入事件日志。")
        if event_name not in EVENTS or count(event.get("seq")) < 1:
            raise HostError("BATCH_EVENT_INVALID", "批次事件类型或序号无效，未写入事件日志。")
        post_fullname = event.get("post_fullname")
        if post_fullname is not None and not valid_fullname(post_fullname, "t3"):
            raise HostError("BATCH_EVENT_INVALID", "批次事件的帖子代码无效，未写入事件日志。")
        return {
            "schema": "reddit-rpa-batch-event-v1", "event_id": f"{batch_id}:{count(event.get('seq'))}", "seq": count(event.get("seq")),
            "at": as_text(event.get("at")) or now(), "batch_id": batch_id, "event": event_name, "post_fullname": post_fullname,
            "elapsed_ms": optional_number(event.get("elapsed_ms")), "attempt": optional_number(event.get("attempt")),
            "reason_code": event.get("reason_code"), "reason": event.get("reason"),
            "reported_comment_count": optional_number(event.get("reported_comment_count")), "collected_comment_count": optional_number(event.get("collected_comment_count")),
            "cooldown_ms": optional_number(event.get("cooldown_ms")), "tree_diagnostics": self.tree_diagnostics(event.get("tree_diagnostics")),
        }

    def store_batch_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        event = self.normalise_event(payload.get("event") or {})
        path = self.root / OUTPUT_LAYER / "batches" / f"{event['batch_id']}.events.jsonl"
        rows = json_lines(path)
        rows.append(event)
        self.atomic_write(path, write_jsonl(rows))
        return {"ok": True, "status": "batch_event_stored", "event": event}

    def posts_in_layer(self, directory: Path, entry: dict[str, Any], context: dict[str, Any]) -> list[dict[str, Any]]:
        if not directory.exists():
            return []
        posts: list[dict[str, Any]] = []
        for post_directory in directory.iterdir():
            if not post_directory.is_dir():
                continue
            document = self.read_json(post_directory / "post.json", optional=True)
            post = document.get("post") if document else None
            if not isinstance(post, dict) or as_text(post.get("subreddit")).lower() != as_text(context.get("subreddit")).lower():
                continue
            thread = self.read_json(post_directory / "thread.json", optional=True) or {}
            posts.append({"directory_name": post_directory.name, "relativePath": f"{OUTPUT_LAYER}/{entry['slug']}/{post_directory.name}", "layer": OUTPUT_LAYER, "post": post, "permalink": post.get("canonical_url"), "captured_at": thread.get("last_captured_at"), "known_comment_count": len(thread.get("comments") or []), "capture_count": count(thread.get("capture_count")), "last_status": (thread.get("latest_capture") or {}).get("status")})
        return posts

    def list_known_posts(self, payload: dict[str, Any]) -> dict[str, Any]:
        context = payload.get("context") or {}
        entry = self.registry_entry(context)
        posts = self.posts_in_layer(self.root / OUTPUT_LAYER / entry["slug"], entry, context)
        posts.sort(key=lambda item: (as_text(item.get("captured_at")), as_text((item.get("post") or {}).get("title"))), reverse=True)
        return {"ok": True, "status": "known_posts", "subreddit": context.get("subreddit"), "posts": posts}

    def validate_comment_owners(self, _payload: dict[str, Any]) -> dict[str, Any]:
        layer = self.root / OUTPUT_LAYER
        owners: dict[str, str] = {}
        duplicates: set[str] = set()
        checked_comments = checked_subreddits = self_parent = mismatch = 0
        if layer.exists():
            for subreddit in layer.iterdir():
                if not subreddit.is_dir() or subreddit.name == "batches":
                    continue
                checked_subreddits += 1
                for post_directory in subreddit.iterdir():
                    if not post_directory.is_dir():
                        continue
                    document = self.read_json(post_directory / "post.json", optional=True) or {}
                    post_fullname = (document.get("post") or {}).get("fullname")
                    for comment in json_lines(post_directory / "comments.jsonl"):
                        if comment.get("record_type") != "comment" or not comment.get("fullname"):
                            continue
                        checked_comments += 1
                        fullname = as_text(comment.get("fullname"))
                        if fullname in owners:
                            duplicates.add(fullname)
                        else:
                            owners[fullname] = f"{subreddit.name}/{post_directory.name}"
                        self_parent += comment.get("parent_fullname") == fullname
                        mismatch += not post_fullname or comment.get("post_fullname") != post_fullname
        return {"ok": True, "status": "comment_owner_check", "scope": OUTPUT_LAYER, "checked_subreddit_count": checked_subreddits, "checked_comment_count": checked_comments, "duplicate_comment_count": len(duplicates), "duplicate_comment_ids": sorted(duplicates)[:20], "self_parent_count": self_parent, "mismatched_post_count": mismatch}

    def control_directories(self) -> tuple[Path, Path]:
        control = self.root / CONTROL_DIRECTORY
        requests, responses = control / "requests", control / "responses"
        requests.mkdir(parents=True, exist_ok=True)
        responses.mkdir(parents=True, exist_ok=True)
        return requests, responses

    def control_claims_directory(self) -> Path:
        directory = self.root / CONTROL_DIRECTORY / "claims"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def collector_directory(self) -> Path:
        directory = self.root / CONTROL_DIRECTORY / "collectors"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def collector_id(self, payload: dict[str, Any]) -> str:
        collector_id = as_text(payload.get("collector_id"))
        if not valid_identifier(collector_id):
            raise HostError("COLLECTOR_ID_INVALID", "采集器缺少有效 collector_id，未处理控制命令。")
        return collector_id

    def write_collector_heartbeat(self, payload: dict[str, Any]) -> dict[str, Any]:
        collector_id = self.collector_id(payload)
        work_tab_id = payload.get("work_tab_id")
        if not isinstance(work_tab_id, int) or isinstance(work_tab_id, bool) or work_tab_id < 0:
            work_tab_id = None
        work_url = as_text(payload.get("work_url")) or None
        if work_url:
            parsed = urlparse(work_url)
            if parsed.scheme != "https" or parsed.hostname not in {"reddit.com", "www.reddit.com"} or not parsed.path.startswith("/r/"):
                raise HostError("COLLECTOR_WORK_PAGE_INVALID", "采集器工作页不是 Reddit 子版块页面，未更新状态。")
        snapshot = {
            "schema": COLLECTOR_SCHEMA,
            "collector_id": collector_id,
            "backend": "native",
            "version": as_text(payload.get("version")) or None,
            "seen_at": now(),
            "work_tab_id": work_tab_id,
            "work_url": work_url,
            "state": as_text(payload.get("state")) or "ready",
        }
        self.atomic_write(self.collector_directory() / f"{collector_id}.json", json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n")
        return {"ok": True, "status": "collector_heartbeat_stored", "collector": snapshot}

    def control_request(self, request: dict[str, Any]) -> dict[str, Any]:
        if request.get("schema") != REQUEST_SCHEMA or not valid_identifier(request.get("request_id")):
            raise HostError("CONTROL_REQUEST_INVALID", "控制请求格式无效，未执行。")
        command = as_text(request.get("command"))
        if command not in COMMANDS:
            raise HostError("CONTROL_COMMAND_INVALID", "控制命令不受支持，未执行。")
        collector_id = as_text(request.get("collector_id"))
        if not valid_identifier(collector_id):
            raise HostError("CONTROL_COLLECTOR_REQUIRED", "控制请求缺少有效 collector_id，未执行。")
        normalised = {"request_id": request["request_id"], "command": command, "created_at": as_text(request.get("created_at")), "collector_id": collector_id, "batch_id": as_text(request.get("batch_id")) or None, "subreddit": None, "count": None}
        if command in {"prepare", "run"}:
            entry = self.registry_entry({"subreddit": request.get("subreddit")}, allow_register=False)
            normalised["subreddit"] = entry["subreddit"]
        if command == "run":
            requested = optional_number(request.get("count"))
            if requested is None or not 1 <= requested <= 50:
                raise HostError("CONTROL_COUNT_INVALID", "控制采集数量必须是 1 到 50 之间的整数，未执行。")
            normalised["count"] = requested
        if command in {"pause", "resume", "cancel"} and not valid_identifier(normalised["batch_id"]):
            raise HostError("CONTROL_BATCH_INVALID", "控制命令缺少有效 batch_id，未执行。")
        return normalised

    def requeue_expired_control_claims(self, requests: Path) -> None:
        claims = self.control_claims_directory()
        deadline = time.time() - CONTROL_CLAIM_LEASE_SECONDS
        for claim_path in sorted(claims.glob("*.json")):
            if claim_path.stat().st_mtime > deadline:
                continue
            try:
                os.replace(claim_path, requests / claim_path.name)
            except FileNotFoundError:
                continue

    def next_control_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        collector_id = self.collector_id(payload)
        requests, responses = self.control_directories()
        self.requeue_expired_control_claims(requests)
        claims = self.control_claims_directory()
        for request_path in sorted(requests.glob("*.json")):
            request_id = request_path.stem
            if not valid_identifier(request_id) or (responses / f"{request_id}.json").exists():
                continue
            try:
                request = self.read_json(request_path)
                assert request is not None
                if as_text(request.get("collector_id")) != collector_id:
                    continue
                try:
                    os.replace(request_path, claims / request_path.name)
                except FileNotFoundError:
                    continue
                request = self.read_json(claims / request_path.name)
                assert request is not None
                normalised = self.control_request(request)
                return {"ok": True, "status": "control_request_pending", "request": normalised, "validation_error": None}
            except (HostError, json.JSONDecodeError) as error:
                code = error.code if isinstance(error, HostError) else "CONTROL_REQUEST_INVALID"
                return {"ok": True, "status": "control_request_pending", "request": {"request_id": request_id, "command": "invalid"}, "validation_error": {"code": code, "error": str(error)}}
        return {"ok": True, "status": "control_idle"}

    def write_control_response(self, payload: dict[str, Any]) -> dict[str, Any]:
        request = payload.get("request") or {}
        request_id = as_text(request.get("request_id"))
        if not valid_identifier(request_id):
            raise HostError("CONTROL_REQUEST_INVALID", "控制请求缺少有效 request_id，未写入响应。")
        _, responses = self.control_directories()
        response = {"schema": RESPONSE_SCHEMA, "request_id": request_id, "command": request.get("command"), "handled_at": now(), **(payload.get("result") or {})}
        self.atomic_write(responses / f"{request_id}.json", json.dumps(response, ensure_ascii=False, indent=2) + "\n")
        (self.control_claims_directory() / f"{request_id}.json").unlink(missing_ok=True)
        return {"ok": bool(response.get("ok")), "status": "control_response_stored", "response": response}

    def cancel_orphaned_batch(self, payload: dict[str, Any]) -> dict[str, Any]:
        lock = payload.get("lock") or {}
        batch_id = as_text(lock.get("batch_id"))
        if not valid_identifier(batch_id):
            raise HostError("ORPHANED_WORKER_INVALID", "遗留工作页锁缺少有效批次标识，未修改批次清单。")
        path = self.root / OUTPUT_LAYER / "batches" / f"{batch_id}.json"
        manifest = self.read_json(path)
        if manifest.get("batch_id") != batch_id:
            raise HostError("ORPHANED_WORKER_BATCH_MISMATCH", "遗留工作页锁与批次清单不匹配，未修改批次清单。")
        if not manifest.get("active") or manifest.get("cancelled"):
            return {"ok": True, "status": "orphaned_batch_already_final"}
        cancelled_at = now()
        manifest.update({"active": False, "paused": False, "cancelled": True, "cancelled_at": cancelled_at, "cancel_reason": "worker_tab_closed"})
        for target in manifest.get("targets") or []:
            if target.get("status") == "running":
                target.update({"status": "interrupted", "error": "唯一工作标签页已关闭", "finished_at": cancelled_at})
            elif target.get("status") == "queued":
                target.update({"status": "unprocessed", "error": None, "finished_at": None})
        self.atomic_write(path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        return {"ok": True, "status": "orphaned_batch_cancelled", "batch_id": batch_id}

    def handle(self, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.ensure_root()
        operations = {
            "status": lambda: {"ok": True, "status": "native_host_connected", "configured": True, "name": self.root.name, "permission": "granted", "backend": "native"},
            "sync_posts": lambda: self.sync_posts(payload), "store_thread": lambda: self.store_thread(payload),
            "record_thread_failure": lambda: self.record_thread_failure(payload), "store_batch": lambda: self.store_batch(payload),
            "store_batch_event": lambda: self.store_batch_event(payload), "list_known_posts": lambda: self.list_known_posts(payload),
            "validate_comment_owners": lambda: self.validate_comment_owners(payload), "write_collector_heartbeat": lambda: self.write_collector_heartbeat(payload), "next_control_request": lambda: self.next_control_request(payload),
            "write_control_response": lambda: self.write_control_response(payload), "cancel_orphaned_batch": lambda: self.cancel_orphaned_batch(payload),
        }
        if operation not in operations:
            raise HostError("NATIVE_OPERATION_INVALID", "Native Host 操作不在白名单中。")
        return operations[operation]()


def read_message() -> dict[str, Any] | None:
    header = sys.stdin.buffer.read(4)
    if not header:
        return None
    length = struct.unpack("<I", header)[0]
    body = sys.stdin.buffer.read(length)
    if len(body) != length:
        return None
    value = json.loads(body.decode("utf-8"))
    return value if isinstance(value, dict) else None


def write_message(value: dict[str, Any]) -> None:
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def main() -> int:
    store = CollectionStore(default_root())
    while message := read_message():
        request_id = message.get("request_id")
        try:
            result = store.handle(as_text(message.get("operation")), message.get("payload") or {})
        except HostError as error:
            result = {"ok": False, "code": error.code, "error": str(error)}
        except Exception as error:  # Keep the native protocol alive without exposing a traceback to Chrome.
            result = {"ok": False, "code": "NATIVE_HOST_FAILED", "error": str(error)}
        write_message({"request_id": request_id, **result})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
