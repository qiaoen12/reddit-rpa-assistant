#!/usr/bin/env python3
"""Migrate verified legacy Reddit thread batches into persistent post folders."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlparse


POST_SCHEMA = "reddit-rpa-post-v1"
THREAD_SCHEMA = "reddit-rpa-thread-v1"
CAPTURE_SCHEMA = "reddit-rpa-thread-capture-v1"
REDDIT_HOSTS = {"reddit.com", "www.reddit.com"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def records_checksum(records: Iterable[dict[str, Any]]) -> str:
    return sha256_bytes(compact_json(list(records)).encode("utf-8"))


def post_id(value: Any) -> str:
    result = str(value or "").strip().lower().removeprefix("t3_")
    if not result or not result.isalnum():
        raise ValueError("帖子代码无效")
    return result


def url_slug(value: Any) -> str:
    decoded = unquote(str(value or "").strip())
    slug = "".join(character.lower() if character.isascii() and character.isalnum() else "_" for character in decoded)
    slug = "_".join(part for part in slug.split("_") if part)[:96]
    if not slug and decoded:
        slug = "_".join(f"u{ord(character):x}" for character in decoded)[:96]
    if not slug:
        raise ValueError("帖子永久链接缺少可用标题")
    return slug


def permalink_details(value: Any, expected_post_id: Any) -> dict[str, str]:
    parsed = urlparse(str(value or ""))
    if parsed.scheme != "https" or parsed.netloc.lower() not in REDDIT_HOSTS:
        raise ValueError("不是 Reddit HTTPS 永久链接")
    segments = [segment for segment in parsed.path.split("/") if segment]
    try:
        comments_index = next(index for index, segment in enumerate(segments) if segment.lower() == "comments")
        from_url = post_id(segments[comments_index + 1])
        raw_slug = segments[comments_index + 2]
    except (StopIteration, IndexError, ValueError) as error:
        raise ValueError("永久链接不含完整帖子代码和标题") from error
    expected = post_id(expected_post_id)
    if from_url != expected:
        raise ValueError("永久链接中的帖子代码与记录不一致")
    if raw_slug.lower() == "comment":
        raise ValueError("永久链接缺少帖子标题段")
    return {
        "post_id": expected,
        "url_slug": url_slug(raw_slug),
        "canonical_url": f"https://{parsed.netloc}/{'/'.join(segments[:comments_index + 3])}/",
    }


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{line_number} 不是 JSON 对象")
        rows.append(value)
    return rows


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    material = list(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.touch()
    if not material:
        return
    with path.open("a", encoding="utf-8") as handle:
        for row in material:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True))
            handle.write("\n")


def stable_comments(records: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for record in records:
        fullname = str(record.get("fullname") or "").strip().lower()
        if record.get("record_type") != "comment" or not fullname.startswith("t1_") or fullname in seen:
            continue
        seen.add(fullname)
        result.append(record)
    return result


def capture_time(payload: dict[str, Any], post: dict[str, Any]) -> str:
    thread_job = ((payload.get("batch") or {}).get("thread_job") or {})
    candidates = [
        thread_job.get("completed_at"),
        payload.get("generated_at"),
        post.get("captured_at"),
        post.get("fetched_at"),
    ]
    return next((str(value) for value in candidates if value), now_iso())


def source_thread(payload: dict[str, Any], source: Path) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str]]:
    records = payload.get("records")
    if payload.get("schema") != "reddit-rpa-batch-v1" or not isinstance(records, list):
        raise ValueError("不是可迁移的旧批次")
    page = payload.get("page") or {}
    if page.get("page_type") != "thread":
        raise ValueError("旧列表批次不具备可靠的逐帖 permalink，禁止迁移")
    posts = [record for record in records if isinstance(record, dict) and record.get("record_type") == "post"]
    if len(posts) != 1:
        raise ValueError("评论树批次必须恰好包含一个帖子记录")
    post = copy.deepcopy(posts[0])
    expected = post_id(post.get("fullname") or post.get("post_fullname") or post.get("post_id"))
    candidates = [page.get("canonical_url"), page.get("source_url"), post.get("canonical_url"), post.get("source_url_or_raw_path")]
    details: dict[str, str] | None = None
    for candidate in candidates:
        try:
            details = permalink_details(candidate, expected)
            break
        except ValueError:
            continue
    if details is None:
        raise ValueError("帖子记录没有与帖子代码匹配的永久链接")
    post["id"] = expected
    post["post_id"] = expected
    post["fullname"] = f"t3_{expected}"
    post["post_fullname"] = post["fullname"]
    post["canonical_url"] = details["canonical_url"]
    post["source_url_or_raw_path"] = details["canonical_url"]
    comments = stable_comments(
        copy.deepcopy(record)
        for record in records
        if isinstance(record, dict) and str(record.get("post_fullname") or "").lower() == post["fullname"]
    )
    if len(comments) != sum(1 for record in records if isinstance(record, dict) and record.get("record_type") == "comment"):
        raise ValueError("评论记录含有重复、无效身份或属于其他帖子，禁止迁移")
    return post, comments, details


def post_document(post: dict[str, Any], details: dict[str, str], captured_at: str, source: Path, source_hash: str) -> dict[str, Any]:
    return {
        "schema": POST_SCHEMA,
        "created_at": captured_at,
        "directory": {
            "name": f"{details['post_id']}--{details['url_slug']}",
            "post_id": details["post_id"],
            "url_slug": details["url_slug"],
        },
        "post": post,
        "migration": {
            "source_file": str(source),
            "source_sha256": source_hash,
            "migrated_at": now_iso(),
        },
    }


def thread_document(post_doc: dict[str, Any], comments: list[dict[str, Any]], captures: list[dict[str, Any]], generated_at: str) -> dict[str, Any]:
    ordered_comments = sorted(
        stable_comments(comments),
        key=lambda record: (str(record.get("published_at") or record.get("captured_at") or ""), str(record.get("fullname") or "")),
    )
    first_capture = captures[0].get("captured_at") if captures else post_doc.get("created_at")
    last_capture = captures[-1].get("captured_at") if captures else first_capture
    return {
        "schema": THREAD_SCHEMA,
        "generated_at": generated_at,
        "first_captured_at": first_capture,
        "last_captured_at": last_capture,
        "capture_count": len(captures),
        "post": post_doc["post"],
        "comments": ordered_comments,
        "latest_capture": captures[-1] if captures else None,
        "quality": captures[-1].get("quality") if captures else None,
    }


def migration_capture(payload: dict[str, Any], source: Path, post: dict[str, Any], comments: list[dict[str, Any]], captured_at: str) -> dict[str, Any]:
    legacy_batch = payload.get("batch") or {}
    return {
        "schema": CAPTURE_SCHEMA,
        "capture_id": f"legacy-{legacy_batch.get('batch_id') or source.stem}",
        "captured_at": captured_at,
        "source_url": (payload.get("page") or {}).get("canonical_url") or post.get("canonical_url"),
        "post_fullname": post["fullname"],
        "reported_comment_count": None,
        "collected_comment_count": len(comments),
        "known_comment_count": len(comments),
        "new_comment_count": len(comments),
        "quality": payload.get("quality") or None,
        "status": "migrated",
        "error": None,
    }


def validate_target(directory: Path, expected_fullname: str) -> dict[str, Any]:
    post_path = directory / "post.json"
    comments_path = directory / "comments.jsonl"
    thread_path = directory / "thread.json"
    post_doc = json.loads(post_path.read_text(encoding="utf-8"))
    comments = read_jsonl(comments_path)
    thread = json.loads(thread_path.read_text(encoding="utf-8"))
    if post_doc.get("schema") != POST_SCHEMA or post_doc.get("post", {}).get("fullname") != expected_fullname:
        raise ValueError("post.json 身份校验失败")
    if thread.get("schema") != THREAD_SCHEMA or thread.get("post", {}).get("fullname") != expected_fullname:
        raise ValueError("thread.json 身份校验失败")
    comment_fullnames = [record.get("fullname") for record in comments]
    if len(comment_fullnames) != len(set(comment_fullnames)):
        raise ValueError("comments.jsonl 含重复评论代码")
    thread_fullnames = [record.get("fullname") for record in thread.get("comments") or []]
    if set(comment_fullnames) != set(thread_fullnames):
        raise ValueError("thread.json 与 comments.jsonl 评论代码不一致")
    return {
        "ok": True,
        "post_fullname": expected_fullname,
        "comment_count": len(comments),
        "comments_sha256": records_checksum(comments),
        "thread_sha256": sha256_file(thread_path),
    }


def migrate_thread(source: Path, raw_root: Path, apply: bool) -> dict[str, Any]:
    source_hash = sha256_file(source)
    payload = json.loads(source.read_text(encoding="utf-8"))
    try:
        post, comments, details = source_thread(payload, source)
    except ValueError as error:
        if (payload.get("page") or {}).get("page_type") == "listing":
            return {
                "source": str(source), "source_sha256": source_hash, "status": "skipped",
                "reason": "LEGACY_LISTING_UNSAFE", "record_count": len(payload.get("records") or []),
            }
        return {"source": str(source), "source_sha256": source_hash, "status": "error", "error": str(error)}
    try:
        subreddit_slug = source.relative_to(raw_root).parts[0]
    except (ValueError, IndexError):
        return {"source": str(source), "source_sha256": source_hash, "status": "error", "error": "无法从旧批次路径识别 subreddit 目录"}
    if not subreddit_slug or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in subreddit_slug):
        return {"source": str(source), "source_sha256": source_hash, "status": "error", "error": "旧批次路径中的 subreddit 目录不安全"}
    directory = raw_root / subreddit_slug / f"{details['post_id']}--{details['url_slug']}"
    captured_at = capture_time(payload, post)
    report: dict[str, Any] = {
        "source": str(source),
        "source_sha256": source_hash,
        "status": "would_migrate" if not apply else "migrated",
        "target_directory": str(directory),
        "post_fullname": post["fullname"],
        "record_count": 1 + len(comments),
        "comment_count": len(comments),
        "records_sha256": records_checksum([post, *comments]),
        "captured_at": captured_at,
    }
    if not apply:
        return report
    directory.mkdir(parents=True, exist_ok=True)
    post_path = directory / "post.json"
    if post_path.exists():
        existing_post = json.loads(post_path.read_text(encoding="utf-8"))
        if existing_post.get("post", {}).get("fullname") != post["fullname"]:
            raise ValueError(f"{directory} 已存在不同帖子身份")
        post_doc = existing_post
    else:
        post_doc = post_document(post, details, captured_at, source, source_hash)
        write_json(post_path, post_doc)
    existing_comments = read_jsonl(directory / "comments.jsonl")
    known = {str(record.get("fullname") or "").lower() for record in stable_comments(existing_comments)}
    additions = [record for record in comments if str(record.get("fullname") or "").lower() not in known]
    append_jsonl(directory / "comments.jsonl", additions)
    all_comments = [*existing_comments, *additions]
    captures = read_jsonl(directory / "captures.jsonl")
    capture = migration_capture(payload, source, post_doc["post"], comments, captured_at)
    if not any(record.get("capture_id") == capture["capture_id"] for record in captures):
        append_jsonl(directory / "captures.jsonl", [capture])
        captures.append(capture)
    write_json(directory / "thread.json", thread_document(post_doc, all_comments, captures, now_iso()))
    report["validation"] = validate_target(directory, post["fullname"])
    return report


def legacy_batch_paths(raw_root: Path) -> list[Path]:
    return sorted(path for path in raw_root.glob("*/runs/**/batch_*.json") if path.is_file())


def clean_or_trash_runs(root: Path, raw_root: Path, report: dict[str, Any], trash_directory: Path) -> None:
    if any(item.get("status") == "error" for item in report["sources"]):
        raise ValueError("存在未通过迁移校验的旧线程批次，未处理任何 runs 目录")
    known_sources = {Path(item["source"]).resolve() for item in report["sources"] if item.get("source")}
    trash_root = trash_directory / f"reddit-rpa-runs-migration-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    for runs in sorted(path for path in raw_root.glob("*/runs") if path.is_dir()):
        if any(runs.iterdir()):
            unknown_files = [
                path
                for path in runs.rglob("*")
                if path.is_file() and path.name != ".DS_Store" and path.resolve() not in known_sources
            ]
            if unknown_files:
                raise ValueError(f"{runs} 包含未核验文件，未移入废纸篓：{unknown_files[0]}")
            relative = runs.relative_to(raw_root)
            target = trash_root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(runs), str(target))
            report["runs_actions"].append({"action": "moved_to_trash", "source": str(runs), "target": str(target)})
        else:
            runs.rmdir()
            report["runs_actions"].append({"action": "removed_empty", "source": str(runs)})


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="迁移旧 Reddit run 批次到长期帖子目录")
    parser.add_argument("--root", type=Path, required=True, help="VR-XR 集合目录")
    parser.add_argument("--apply", action="store_true", help="实际写入帖子目录；省略时仅演练")
    parser.add_argument("--trash-runs", action="store_true", help="校验成功后将旧 runs 移入废纸篓，并移除空 runs 目录")
    parser.add_argument("--trash-directory", type=Path, default=Path.home() / ".Trash", help="废纸篓根目录，测试时可指定临时目录")
    parser.add_argument("--report", type=Path, help="迁移报告路径，默认写入 insights/legacy/")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    root = args.root.resolve()
    raw_root = root / "raw"
    if not raw_root.is_dir():
        print(f"原始目录不存在：{raw_root}", file=sys.stderr)
        return 2
    if args.trash_runs and not args.apply:
        print("--trash-runs 需要同时使用 --apply", file=sys.stderr)
        return 2
    report_path = args.report or root / "insights" / "legacy" / "post_storage_migration_report.json"
    report: dict[str, Any] = {
        "schema": "reddit-rpa-post-storage-migration-v1",
        "generated_at": now_iso(),
        "root": str(root),
        "apply": args.apply,
        "trash_runs": args.trash_runs,
        "sources": [],
        "runs_actions": [],
    }
    try:
        for source in legacy_batch_paths(raw_root):
            report["sources"].append(migrate_thread(source, raw_root, args.apply))
        if args.apply and any(item.get("status") == "error" for item in report["sources"]):
            raise ValueError("迁移中存在错误，旧 runs 未移入废纸篓")
        if args.trash_runs:
            clean_or_trash_runs(root, raw_root, report, args.trash_directory.resolve())
        report["summary"] = {
            "migrated": sum(item.get("status") == "migrated" for item in report["sources"]),
            "would_migrate": sum(item.get("status") == "would_migrate" for item in report["sources"]),
            "skipped": sum(item.get("status") == "skipped" for item in report["sources"]),
            "errors": sum(item.get("status") == "error" for item in report["sources"]),
        }
        write_json(report_path, report)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        report["error"] = str(error)
        write_json(report_path, report)
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(report["summary"], ensure_ascii=False))
    print(f"迁移报告：{report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
