#!/usr/bin/env python3
"""从 raw/ 的最新 capture 生成只读的评论树质量复核队列。"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any


OUTPUT_LAYER = "raw"


REVIEW_STATUSES = {"tree_partial", "manual", "failed"}
LEVEL_ORDER = {"high": 0, "normal": 1, "low": 2}


def default_root() -> Path:
    return Path(__file__).resolve().parents[3] / "VR-XR"


def read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else None


def json_lines(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            value = json.loads(line)
            if isinstance(value, dict):
                rows.append(value)
    return rows


def number(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def diagnostic_codes(capture: dict[str, Any], quality: dict[str, Any]) -> list[str]:
    diagnostics = capture.get("tree_diagnostics") if isinstance(capture.get("tree_diagnostics"), dict) else {}
    codes = [str(code) for code in diagnostics.get("reason_codes", []) if str(code)]
    if quality.get("unexpanded_controls"):
        codes.append("UNEXPANDED_COMMENT_CONTROL")
    reported = number(capture.get("reported_comment_count"))
    collected = number(capture.get("collected_comment_count")) or 0
    gap = number(capture.get("comment_count_gap"))
    if reported and collected == 0:
        codes.append("REPORTED_NONZERO_COLLECTED_ZERO")
    if gap is not None and abs(gap) > 1:
        codes.append("COMMENT_COUNT_GAP_GT_ONE")
    status = str(capture.get("status") or "")
    if status == "tree_partial" and not diagnostics:
        codes.append("HISTORICAL_DIAGNOSTIC_UNAVAILABLE")
    return list(dict.fromkeys(codes))


def review_level_and_action(capture: dict[str, Any], quality: dict[str, Any], codes: list[str]) -> tuple[str, str]:
    status = str(capture.get("status") or "")
    coverage = str(capture.get("coverage_status") or status)
    reported = number(capture.get("reported_comment_count"))
    collected = number(capture.get("collected_comment_count")) or 0
    gap = number(capture.get("comment_count_gap")) or 0
    if status == "failed":
        return "high", "检查失败原因与工作页；不要直接跳到下一 Subreddit。"
    if status == "manual" and reported and collected == 0:
        return "high", "打开永久链接，检查错误页、限流或评论组件未加载；页面恢复后才受控单帖重采。"
    if status == "manual" and (abs(gap) > 1 or quality.get("unexpanded_controls")):
        return "high", "核对页头数和未展开控件；必要时只重采当前帖子。"
    if status == "manual":
        return "high", "打开永久链接核对当前页面；保留原 capture，不直接升级为 complete。"
    if coverage == "complete_with_reported_count_gap":
        return "low", "保留审计；仅在分析需要精确 Reddit 页头总数时复核。"
    if status == "tree_partial" and "DELETED_ANCESTOR_OBSERVED" in codes:
        return "normal", "仅在需要回复链分析时核对删除父级；平面主题/情绪分析可继续使用。"
    return "normal", "抽样检查原生父级路径，确认是否为页面结构或加载变化。"


def scoped_posts(root: Path, scope_path: Path | None) -> set[tuple[str, str]] | None:
    if not scope_path or not scope_path.exists():
        return None
    scope = read_json(scope_path)
    allowed: set[tuple[str, str]] = set()
    for batch_id in scope.get("approved_batch_ids", []):
        batch = read_json(root / OUTPUT_LAYER / "batches" / f"{batch_id}.json")
        subreddit = str((batch or {}).get("subreddit") or "").lower()
        for target in (batch or {}).get("targets", []):
            if isinstance(target, dict) and target.get("fullname"):
                allowed.add((subreddit, str(target["fullname"])))
    return allowed


def queue_items(root: Path, scope_path: Path | None = None) -> list[dict[str, Any]]:
    layer = root / OUTPUT_LAYER
    if not layer.exists():
        return []
    allowed_posts = scoped_posts(root, scope_path)
    items: list[dict[str, Any]] = []
    for subreddit_directory in sorted(layer.iterdir()):
        if not subreddit_directory.is_dir() or subreddit_directory.name == "batches":
            continue
        for post_directory in sorted(subreddit_directory.iterdir()):
            if not post_directory.is_dir():
                continue
            post_document = read_json(post_directory / "post.json") or {}
            post = post_document.get("post") if isinstance(post_document.get("post"), dict) else {}
            post_fullname = post.get("fullname")
            if allowed_posts is not None and (str(post.get("subreddit") or "").lower(), str(post_fullname or "")) not in allowed_posts:
                continue
            captures = json_lines(post_directory / "captures.jsonl")
            if not captures:
                continue
            capture = captures[-1]
            status = str(capture.get("status") or "")
            coverage = str(capture.get("coverage_status") or status)
            if status not in REVIEW_STATUSES and coverage != "complete_with_reported_count_gap":
                continue
            quality = capture.get("quality") if isinstance(capture.get("quality"), dict) else {}
            codes = diagnostic_codes(capture, quality)
            level, action = review_level_and_action(capture, quality, codes)
            permalink = post.get("canonical_url") or post.get("source_url") or capture.get("source_url")
            items.append({
                "level": level,
                "subreddit": subreddit_directory.name,
                "post_fullname": post_fullname or capture.get("post_fullname"),
                "permalink": permalink,
                "latest_capture_at": capture.get("captured_at"),
                "status": status,
                "coverage_status": coverage,
                "reported_comment_count": number(capture.get("reported_comment_count")),
                "collected_comment_count": number(capture.get("collected_comment_count")) or 0,
                "comment_count_gap": number(capture.get("comment_count_gap")),
                "unknown_parent_comment_count": number(quality.get("unknown_parent_comment")) or 0,
                "reason_codes": codes,
                "recommended_action": action,
                "capture_path": str((post_directory / "captures.jsonl").relative_to(root)),
            })
    return sorted(items, key=lambda item: (LEVEL_ORDER[item["level"]], item["subreddit"], str(item["post_fullname"] or "")))


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


def review_categories(items: list[dict[str, Any]]) -> dict[str, int]:
    statuses = Counter(str(item["status"] or "unknown") for item in items)
    return {
        "manual": statuses["manual"],
        "tree_partial": statuses["tree_partial"],
        "failed": statuses["failed"],
        "complete_with_reported_count_gap": sum(
            item["coverage_status"] == "complete_with_reported_count_gap" for item in items
        ),
    }


def markdown(items: list[dict[str, Any]], generated_at: str, categories: dict[str, int]) -> str:
    rows = [
        "# 评论树质量复核队列",
        "",
        f"生成时间：{generated_at}",
        "",
        f"共 {len(items)} 项；此队列只引用 capture 与永久链接，不包含 Comment 正文，也不回写 `raw/`。",
        "",
        "- 分组："
        f"`manual` {categories['manual']}，`tree_partial` {categories['tree_partial']}，"
        f"`failed` {categories['failed']}，"
        f"`complete_with_reported_count_gap` {categories['complete_with_reported_count_gap']}（低优先级审计，"
        "不等同于 `tree_partial` 或 `manual`）。",
        "",
        "| 级别 | Subreddit | Post | 状态/覆盖 | 页头/已采/差异 | 未知父级 | 原因 | 建议动作 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for item in items:
        post = f"[{item['post_fullname']}]({item['permalink']})" if item.get("permalink") else str(item["post_fullname"] or "-")
        counts = f"{item['reported_comment_count'] if item['reported_comment_count'] is not None else '-'} / {item['collected_comment_count']} / {item['comment_count_gap'] if item['comment_count_gap'] is not None else '-'}"
        codes = ", ".join(item["reason_codes"]) or "-"
        state = item["status"] if item["coverage_status"] == item["status"] else f"{item['status']} / {item['coverage_status']}"
        rows.append(f"| {item['level']} | {item['subreddit']} | {post} | {state} | {counts} | {item['unknown_parent_comment_count']} | {codes} | {item['recommended_action']} |")
    return "\n".join(rows) + "\n"


def build_queue(root: Path, output_directory: Path, queue_date: str, scope_path: Path | None = None) -> dict[str, Any]:
    items = queue_items(root, scope_path)
    categories = review_categories(items)
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    jsonl_path = output_directory / f"comment_tree_review_queue_{queue_date}.jsonl"
    markdown_path = output_directory / f"comment_tree_review_queue_{queue_date}.md"
    atomic_write(jsonl_path, "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in items))
    atomic_write(markdown_path, markdown(items, generated_at, categories))
    return {
        "ok": True,
        "status": "comment_tree_review_queue_built",
        "item_count": len(items),
        "levels": {level: sum(item["level"] == level for item in items) for level in LEVEL_ORDER},
        "categories": categories,
        "scope_path": str(scope_path) if scope_path else None,
        "jsonl_path": str(jsonl_path),
        "markdown_path": str(markdown_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 raw 的只读评论树质量复核队列")
    parser.add_argument("--root", type=Path, default=default_root(), help="VR-XR 集合目录")
    parser.add_argument("--out", type=Path, default=None, help="输出目录，默认 insights/quality")
    parser.add_argument("--scope", type=Path, required=True, help="正式批次范围文件；必须显式指定，避免混入历史批次")
    parser.add_argument("--date", dest="queue_date", default=date.today().isoformat(), help="输出文件日期（YYYY-MM-DD）")
    args = parser.parse_args()
    root = args.root.expanduser().resolve()
    output_directory = (args.out or root / "insights" / "quality").expanduser().resolve()
    scope_path = args.scope.expanduser().resolve()
    if not scope_path.is_file():
        parser.error(f"scope 文件不存在：{scope_path}")
    result = build_queue(root, output_directory, args.queue_date, scope_path)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
