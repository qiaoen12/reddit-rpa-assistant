#!/usr/bin/env python3
"""只验证批准 scope 内的批次和帖子，避免历史遗留数据污染最终验收。"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Any


TERMINAL = {"complete", "tree_partial", "manual", "failed", "interrupted"}


def default_root() -> Path:
    return Path(__file__).resolve().parents[3] / "VR-XR"


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON 对象无效：{path}")
    return value


def json_lines(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [value for line in path.read_text(encoding="utf-8").splitlines() if line.strip() if isinstance((value := json.loads(line)), dict)]


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def scope_expectations(scope: dict[str, Any]) -> dict[str, int]:
    return {str(item["subreddit"]).lower(): int(item["expected_target_count"]) for item in scope.get("approved_short_lists", []) if isinstance(item, dict)}


def post_directories(root: Path, expected: set[tuple[str, str]]) -> dict[tuple[str, str], Path]:
    found: dict[tuple[str, str], Path] = {}
    layer = root / "raw-v2"
    for subreddit in layer.iterdir() if layer.exists() else []:
        if not subreddit.is_dir() or subreddit.name == "batches":
            continue
        for directory in subreddit.iterdir():
            if not directory.is_dir():
                continue
            post_document_path = directory / "post.json"
            if not post_document_path.exists():
                continue
            post = (read_json(post_document_path).get("post") or {})
            key = (str(post.get("subreddit") or "").lower(), str(post.get("fullname") or ""))
            if key in expected:
                found[key] = directory
    return found


def verify_scope(root: Path, scope_path: Path) -> dict[str, Any]:
    scope = read_json(scope_path)
    batch_ids = [str(value) for value in scope.get("approved_batch_ids", [])]
    if len(batch_ids) != len(set(batch_ids)):
        raise ValueError("scope 中存在重复 batch_id。")
    short_lists = scope_expectations(scope)
    violations: list[dict[str, str]] = []
    terminal_counts: Counter[str] = Counter()
    expected_targets: set[tuple[str, str]] = set()
    batch_summaries: list[dict[str, Any]] = []
    batches_root = root / "raw-v2" / "batches"
    for batch_id in batch_ids:
        path = batches_root / f"{batch_id}.json"
        if not path.exists():
            violations.append({"code": "BATCH_MISSING", "batch_id": batch_id})
            continue
        batch = read_json(path)
        subreddit = str(batch.get("subreddit") or "")
        targets = [target for target in batch.get("targets", []) if isinstance(target, dict)]
        expected_count = short_lists.get(subreddit.lower(), int(scope.get("default_target_count") or 25))
        statuses = Counter(str(target.get("status") or "unknown") for target in targets)
        terminal_count = sum(count for status, count in statuses.items() if status in TERMINAL)
        terminal_counts.update({status: count for status, count in statuses.items() if status in TERMINAL})
        if batch.get("active") or terminal_count != len(targets) or len(targets) != expected_count:
            violations.append({"code": "BATCH_NOT_ACCEPTED", "batch_id": batch_id})
        for target in targets:
            fullname = str(target.get("fullname") or "")
            if fullname:
                expected_targets.add((subreddit.lower(), fullname))
        batch_summaries.append({"batch_id": batch_id, "subreddit": subreddit, "selected_count": len(targets), "terminal_count": terminal_count, "status_counts": dict(statuses)})

    directories = post_directories(root, expected_targets)
    owners: dict[str, str] = {}
    duplicate_comments: set[str] = set()
    self_parent = mismatched_post = missing_capture = 0
    for key in expected_targets:
        directory = directories.get(key)
        if not directory:
            violations.append({"code": "POST_DIRECTORY_MISSING", "post_fullname": key[1]})
            continue
        if not (directory / "captures.jsonl").exists() or not json_lines(directory / "captures.jsonl"):
            missing_capture += 1
            violations.append({"code": "CAPTURE_MISSING", "post_fullname": key[1]})
        post_fullname = key[1]
        for comment in json_lines(directory / "comments.jsonl"):
            if comment.get("record_type") != "comment" or not comment.get("fullname"):
                continue
            fullname = str(comment["fullname"])
            if fullname in owners:
                duplicate_comments.add(fullname)
            else:
                owners[fullname] = str(directory.relative_to(root))
            self_parent += comment.get("parent_fullname") == fullname
            mismatched_post += comment.get("post_fullname") != post_fullname
    if duplicate_comments:
        violations.append({"code": "DUPLICATE_COMMENT", "count": str(len(duplicate_comments))})
    if self_parent:
        violations.append({"code": "SELF_PARENT", "count": str(self_parent)})
    if mismatched_post:
        violations.append({"code": "COMMENT_POST_MISMATCH", "count": str(mismatched_post)})

    return {
        "ok": not violations,
        "status": "collection_scope_verified",
        "scope_id": scope.get("scope_id"),
        "scope_path": str(scope_path.relative_to(root)),
        "approved_batch_count": len(batch_ids),
        "approved_target_count": len(expected_targets),
        "terminal_status_counts": dict(terminal_counts),
        "post_directory_count": len(directories),
        "checked_comment_count": len(owners),
        "duplicate_comment_count": len(duplicate_comments),
        "self_parent_count": self_parent,
        "mismatched_post_count": mismatched_post,
        "missing_capture_count": missing_capture,
        "violations": violations,
        "batches": batch_summaries,
        "approved_short_lists": scope.get("approved_short_lists", []),
        "excluded_subreddits": scope.get("excluded_subreddits", []),
    }


def markdown(result: dict[str, Any]) -> str:
    rows = [
        "# 初始全量采集验收清单",
        "",
        f"Scope：`{result['scope_id']}`",
        "",
        f"- 批次：{result['approved_batch_count']}；目标：{result['approved_target_count']}；帖子目录：{result['post_directory_count']}。",
        f"- 终态：{json.dumps(result['terminal_status_counts'], ensure_ascii=False)}。",
        f"- Comment 校验：{result['checked_comment_count']} 条，重复 {result['duplicate_comment_count']}、自指 {result['self_parent_count']}、错归属 {result['mismatched_post_count']}。",
        f"- 结论：{'通过' if result['ok'] else '未通过'}。历史批次不计入本清单。",
        "",
        "| Batch | Subreddit | 目标 | 终态 |",
        "| --- | --- | ---: | --- |",
    ]
    for batch in result["batches"]:
        rows.append(f"| {batch['batch_id']} | {batch['subreddit']} | {batch['selected_count']} | {json.dumps(batch['status_counts'], ensure_ascii=False)} |")
    if result["violations"]:
        rows.extend(["", "## 未通过项", ""])
        rows.extend(f"- `{item['code']}`：{item}" for item in result["violations"])
    return "\n".join(rows) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="验证正式采集 scope，不混入历史批次")
    parser.add_argument("--root", type=Path, default=default_root())
    parser.add_argument("--scope", type=Path, required=True, help="正式范围文件；必须显式指定")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--date", dest="report_date", default=date.today().isoformat())
    args = parser.parse_args()
    root = args.root.expanduser().resolve()
    scope_path = args.scope.expanduser().resolve()
    if not scope_path.is_file():
        parser.error(f"scope 文件不存在：{scope_path}")
    result = verify_scope(root, scope_path)
    output = (args.out or root / "insights" / "quality").expanduser().resolve()
    json_path = output / f"collection_scope_acceptance_{args.report_date}.json"
    markdown_path = output / f"collection_scope_acceptance_{args.report_date}.md"
    atomic_write(json_path, json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    atomic_write(markdown_path, markdown(result))
    print(json.dumps({"ok": result["ok"], "json_path": str(json_path), "markdown_path": str(markdown_path), "violation_count": len(result["violations"])}, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
