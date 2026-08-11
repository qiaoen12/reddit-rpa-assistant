#!/usr/bin/env python3
"""Build immutable raw and analysis-friendly clean Reddit JSONL documents."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"第 {line_number} 行不是 JSON 对象")
        records.append(value)
    return records


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True))
            handle.write("\n")


def clean_record(record: dict[str, Any], collection_name: str, subreddit: str) -> dict[str, Any]:
    allowed = {
        "id", "fullname", "record_type", "title", "content", "source_id", "source_name",
        "source_url_or_raw_path", "canonical_url", "fetched_at", "published_at", "updated_at",
        "categories", "content_hash", "confidence", "unsupported_fields", "errors", "subreddit",
        "post_id", "post_fullname", "parent_fullname", "depth", "author", "author_url", "edited",
        "attachments", "score", "captured_at", "extractor", "last_seen_at"
    }
    cleaned = {key: record.get(key) for key in allowed if key in record}
    cleaned["collection"] = collection_name
    cleaned["subreddit"] = subreddit
    cleaned["translation_status"] = "pending"
    return cleaned


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成 Reddit 原始副本和清洁主文件")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--raw-out", type=Path, required=True)
    parser.add_argument("--clean-out", type=Path, required=True)
    parser.add_argument("--collection-name", required=True)
    parser.add_argument("--subreddit", required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    records = read_jsonl(args.input)
    target = args.subreddit.lower()
    selected = [record for record in records if str(record.get("subreddit") or "").lower() == target]
    if not selected:
        print(f"输入中没有 r/{args.subreddit} 记录。", file=sys.stderr)
        return 2
    write_jsonl(args.raw_out, selected)
    write_jsonl(args.clean_out, [clean_record(record, args.collection_name, args.subreddit) for record in selected])
    print(f"写入 {len(selected)} 条 r/{args.subreddit} 原始与清洁记录。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
