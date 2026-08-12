#!/usr/bin/env python3
"""Deterministically merge per-post Reddit RPA thread documents."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def record_key(record: dict[str, Any]) -> str | None:
    fullname = str(record.get("fullname") or "").strip().lower()
    if fullname.startswith(("t1_", "t3_")):
        return fullname
    return None


def text(value: Any) -> str:
    return " ".join(str(value or "").split())


def normalise_record(record: dict[str, Any]) -> dict[str, Any] | None:
    key = record_key(record)
    record_type = str(record.get("record_type") or "").strip()
    if not key or record_type not in {"post", "comment"}:
        return None
    result = dict(record)
    result["fullname"] = key
    result["record_type"] = record_type
    result["id"] = str(result.get("id") or key.split("_", 1)[1])
    result["title"] = text(result.get("title"))
    result["content"] = text(result.get("content"))
    result["attachments"] = sorted({str(item) for item in result.get("attachments") or [] if str(item)})
    result["categories"] = sorted({str(item) for item in result.get("categories") or [] if str(item)})
    result["author"] = text(result.get("author")) or None
    result["canonical_url"] = str(result.get("canonical_url") or result.get("source_url_or_raw_path") or "").strip() or None
    result["source_url_or_raw_path"] = result["canonical_url"]
    result["post_fullname"] = str(result.get("post_fullname") or (key if record_type == "post" else "")).lower() or None
    result["parent_fullname"] = str(result.get("parent_fullname") or "").lower() or None
    try:
        result["depth"] = max(0, int(result.get("depth") or 0))
    except (TypeError, ValueError):
        result["depth"] = 0
    result["content_hash"] = str(result.get("content_hash") or hashlib.sha256(
        json_dumps([result["fullname"], result["title"], result["content"], result["canonical_url"]]).encode("utf-8")
    ).hexdigest())
    return result


def prefer_record(current: dict[str, Any] | None, candidate: dict[str, Any]) -> dict[str, Any]:
    if current is None:
        return candidate
    merged = {**current, **candidate}
    if len(text(current.get("content"))) > len(text(candidate.get("content"))):
        merged["content"] = current.get("content", "")
    if not candidate.get("title") and current.get("title"):
        merged["title"] = current.get("title")
    for field in ("author", "author_url", "published_at", "updated_at", "canonical_url", "source_url_or_raw_path", "parent_fullname", "post_fullname"):
        if not candidate.get(field) and current.get(field):
            merged[field] = current[field]
    merged["attachments"] = sorted(set((current.get("attachments") or []) + (candidate.get("attachments") or [])))
    merged["categories"] = sorted(set((current.get("categories") or []) + (candidate.get("categories") or [])))
    merged["last_seen_at"] = candidate.get("captured_at") or current.get("captured_at")
    return merged


def deduplicate(records: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    by_key: dict[str, dict[str, Any]] = {}
    for original in records:
        record = normalise_record(original)
        if record is None:
            continue
        key = record["fullname"]
        by_key[key] = prefer_record(by_key.get(key), record)
    return sorted(
        by_key.values(),
        key=lambda item: (0 if item["record_type"] == "post" else 1, item.get("published_at") or item.get("captured_at") or "", item["fullname"]),
    )


def batch_paths(input_path: Path) -> list[Path]:
    if input_path.is_file():
        return [input_path]
    paths = {
        path
        for pattern in ("thread.json", "batch_*.json")
        for path in input_path.rglob(pattern)
        if path.is_file()
    }
    return sorted(paths)


def read_batches(input_path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    records: list[dict[str, Any]] = []
    batches: list[dict[str, Any]] = []
    errors: list[str] = []
    for path in batch_paths(input_path):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            errors.append(f"{path.name}: {error}")
            continue
        if payload.get("schema") == "reddit-rpa-thread-v1":
            post = payload.get("post")
            comments = payload.get("comments")
            if not isinstance(post, dict) or not isinstance(comments, list):
                errors.append(f"{path}: thread.json 缺少 post 或 comments 数组")
                continue
            records.append(post)
            records.extend(item for item in comments if isinstance(item, dict))
            latest_capture = payload.get("latest_capture") if isinstance(payload.get("latest_capture"), dict) else {}
            batches.append({
                "path": str(path),
                "source_kind": "thread",
                "batch": {"capture_count": payload.get("capture_count") or 0},
                "page": {"post_fullname": post.get("fullname"), "subreddit": post.get("subreddit")},
                "quality": latest_capture.get("quality") or payload.get("quality") or {},
            })
            continue
        if payload.get("schema") == "reddit-rpa-batch-v1":
            raw_records = payload.get("records")
            if not isinstance(raw_records, list):
                errors.append(f"{path.name}: records 不是数组")
                continue
            records.extend(item for item in raw_records if isinstance(item, dict))
            batches.append({
                "path": str(path),
                "source_kind": "legacy_batch",
                "batch": payload.get("batch") or {},
                "page": payload.get("page") or {},
                "quality": payload.get("quality") or {},
            })
            continue
        errors.append(f"{path.name}: 非 reddit-rpa-thread-v1 或 reddit-rpa-batch-v1")
    return records, batches, errors


def date_key(record: dict[str, Any]) -> str:
    raw = str(record.get("published_at") or record.get("captured_at") or "")
    return raw[:10] if len(raw) >= 10 else "unknown"


def quality_report(records: list[dict[str, Any]], batches: list[dict[str, Any]], errors: list[str]) -> dict[str, Any]:
    fullnames = {record["fullname"] for record in records}
    comments = [record for record in records if record["record_type"] == "comment"]
    continuation_urls = sorted({url for batch in batches for url in (batch.get("quality") or {}).get("continuation_urls", []) if url})
    unexpanded = sorted({text_value for batch in batches for text_value in (batch.get("quality") or {}).get("unexpanded_controls", []) if text_value})
    orphan_parents = sorted({record["parent_fullname"] for record in comments if record.get("parent_fullname", "").startswith("t1_") and record["parent_fullname"] not in fullnames})
    return {
        "schema": "reddit-rpa-quality-v1",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "record_count": len(records),
        "post_count": sum(record["record_type"] == "post" for record in records),
        "comment_count": len(comments),
        "missing_author": sum(not record.get("author") for record in records),
        "missing_permalink": sum(not record.get("canonical_url") for record in records),
        "orphan_parent_fullnames": orphan_parents,
        "continuation_urls": continuation_urls,
        "unexpanded_controls": unexpanded,
        "input_batch_count": len(batches),
        "input_thread_count": sum(batch.get("source_kind") == "thread" for batch in batches),
        "input_legacy_batch_count": sum(batch.get("source_kind") == "legacy_batch" for batch in batches),
        "input_errors": errors,
    }


def write_jsonl(path: Path, records: Iterable[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True))
            handle.write("\n")


def write_sqlite(path: Path, records: list[dict[str, Any]]) -> None:
    if path.exists():
        path.unlink()
    connection = sqlite3.connect(path)
    try:
        connection.execute("""
            CREATE TABLE records (
              fullname TEXT PRIMARY KEY,
              record_type TEXT NOT NULL,
              subreddit TEXT,
              post_fullname TEXT,
              parent_fullname TEXT,
              depth INTEGER,
              author TEXT,
              title TEXT,
              content TEXT,
              canonical_url TEXT,
              published_at TEXT,
              captured_at TEXT,
              data_json TEXT NOT NULL
            )
        """)
        connection.executemany(
            """INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    record["fullname"], record["record_type"], record.get("subreddit"), record.get("post_fullname"),
                    record.get("parent_fullname"), record.get("depth"), record.get("author"), record.get("title"),
                    record.get("content"), record.get("canonical_url"), record.get("published_at"), record.get("captured_at"),
                    json.dumps(record, ensure_ascii=False, sort_keys=True),
                )
                for record in records
            ],
        )
        connection.execute("CREATE INDEX idx_records_post ON records(post_fullname)")
        connection.execute("CREATE INDEX idx_records_parent ON records(parent_fullname)")
        connection.commit()
    finally:
        connection.close()


def write_summaries(output: Path, records: list[dict[str, Any]], prefix: str) -> None:
    daily: dict[str, Counter[str]] = {}
    subreddit: dict[str, Counter[str]] = {}
    for record in records:
        daily.setdefault(date_key(record), Counter())[record["record_type"]] += 1
        subreddit.setdefault(str(record.get("subreddit") or "unknown"), Counter())[record["record_type"]] += 1
    with (output / f"{prefix}daily_summary.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["date", "posts", "comments", "records"])
        for day, counts in sorted(daily.items()):
            writer.writerow([day, counts["post"], counts["comment"], counts["post"] + counts["comment"]])
    with (output / f"{prefix}subreddit_summary.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["subreddit", "posts", "comments", "records"])
        for name, counts in sorted(subreddit.items()):
            writer.writerow([name, counts["post"], counts["comment"], counts["post"] + counts["comment"]])


def write_summary(path: Path, records: list[dict[str, Any]], quality: dict[str, Any]) -> None:
    lines = [
        "# Reddit 采集汇总",
        "",
        f"- 去重后记录：{len(records)}",
        f"- 帖子：{quality['post_count']}",
        f"- 评论：{quality['comment_count']}",
        f"- 缺作者：{quality['missing_author']}",
        f"- 缺永久链接：{quality['missing_permalink']}",
        f"- 未展开控件：{len(quality['unexpanded_controls'])}",
        f"- 评论续串：{len(quality['continuation_urls'])}",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="合并 Reddit RPA 帖子评论树并生成确定性统计")
    parser.add_argument("--input", type=Path, required=True, help="单个 thread.json，或包含帖子目录的 raw/<subreddit> 目录")
    parser.add_argument("--out", type=Path, required=True, help="输出目录，通常位于 clean/<subreddit>/")
    parser.add_argument("--prefix", default="", help="可选文件名前缀，例如 2026-08-07_120000_000_")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.input.exists():
        print(f"输入不存在：{args.input}", file=sys.stderr)
        return 2
    args.out.mkdir(parents=True, exist_ok=True)
    prefix = f"{args.prefix}_" if args.prefix and not args.prefix.endswith("_") else args.prefix
    raw_records, batches, errors = read_batches(args.input)
    records = deduplicate(raw_records)
    quality = quality_report(records, batches, errors)
    write_jsonl(args.out / f"{prefix}reddit_records_merged.jsonl", records)
    write_sqlite(args.out / f"{prefix}reddit_records.sqlite3", records)
    write_summaries(args.out, records, prefix)
    (args.out / f"{prefix}quality_report.json").write_text(json.dumps(quality, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_summary(args.out / f"{prefix}summary.md", records, quality)
    print(f"去重后 {len(records)} 条 Reddit 记录。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
