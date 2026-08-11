#!/usr/bin/env python3
"""Prepare and assemble local AI-assisted bilingual Reddit data files."""

from __future__ import annotations

import argparse
import html
import json
import sys
from pathlib import Path
from typing import Any, Iterable


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row, dict):
            raise ValueError(f"{path}:{line_number} 不是 JSON 对象")
        rows.append(row)
    return rows


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True))
            handle.write("\n")


def translation_key(row: dict[str, Any]) -> str | None:
    return str(row.get("fullname") or row.get("id") or "").strip() or None


def prepare(input_path: Path, chunks_out: Path, chunk_size: int) -> int:
    rows = read_jsonl(input_path)
    chunks_out.mkdir(parents=True, exist_ok=True)
    for start in range(0, len(rows), chunk_size):
        chunk: list[dict[str, Any]] = []
        for row in rows[start:start + chunk_size]:
            item = dict(row)
            item["content_zh"] = str(item.get("content_zh") or "")
            item["title_zh"] = str(item.get("title_zh") or "")
            item["translation_status"] = "pending"
            chunk.append(item)
        write_jsonl(chunks_out / f"{start // chunk_size + 1:03d}_source.jsonl", chunk)
    print(f"已写入 {len(rows)} 条翻译输入，分为 {(len(rows) + chunk_size - 1) // chunk_size} 个分块。")
    return 0


def translation_rows(chunks: Path) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    paths = [chunks] if chunks.is_file() else sorted(chunks.glob("*.jsonl"))
    for path in paths:
        for row in read_jsonl(path):
            key = translation_key(row)
            if key:
                found[key] = row
    return found


def html_view(rows: list[dict[str, Any]]) -> str:
    lines = [
        "<!doctype html>", "<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>Reddit 双语查看</title>",
        "<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:24px;color:#1f2937}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #cbd5e1;padding:8px;vertical-align:top;overflow-wrap:anywhere;text-align:left;font-size:13px}th{background:#eff6ff}code{font-size:11px}</style></head><body>",
        "<h1>Reddit 双语查看</h1><table><thead><tr><th>类型</th><th>原文</th><th>中文</th><th>来源</th></tr></thead><tbody>"
    ]
    for row in rows:
        source = html.escape(str(row.get("canonical_url") or ""))
        source_link = f'<a href="{source}">链接</a>' if source else ""
        original = "<br>".join(filter(None, [html.escape(str(row.get("title") or "")), html.escape(str(row.get("content") or ""))]))
        translated = "<br>".join(filter(None, [html.escape(str(row.get("title_zh") or "")), html.escape(str(row.get("content_zh") or ""))]))
        lines.append(f"<tr><td><code>{html.escape(str(row.get('record_type') or ''))}</code></td><td>{original}</td><td>{translated}</td><td>{source_link}</td></tr>")
    lines.append("</tbody></table></body></html>")
    return "\n".join(lines) + "\n"


def assemble(input_path: Path, chunks: Path, out: Path, view_out: Path) -> int:
    source_rows = read_jsonl(input_path)
    translations = translation_rows(chunks)
    assembled: list[dict[str, Any]] = []
    missing = 0
    for source in source_rows:
        row = dict(source)
        translated = translations.get(translation_key(source) or "", {})
        row["content_zh"] = str(translated.get("content_zh") or "")
        row["title_zh"] = str(translated.get("title_zh") or "")
        row["translation_status"] = "translated" if row["content_zh"] or not row.get("content") else "pending"
        if row["translation_status"] == "pending":
            missing += 1
        assembled.append(row)
    write_jsonl(out, assembled)
    view_out.parent.mkdir(parents=True, exist_ok=True)
    view_out.write_text(html_view(assembled), encoding="utf-8")
    print(f"写入 {len(assembled)} 条双语记录，待翻译 {missing} 条。")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="准备或汇总 Reddit 本地 AI 辅助翻译文件")
    subcommands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = subcommands.add_parser("prepare")
    prepare_parser.add_argument("--input", type=Path, required=True)
    prepare_parser.add_argument("--chunks-out", type=Path, required=True)
    prepare_parser.add_argument("--chunk-size", type=int, default=100)
    assemble_parser = subcommands.add_parser("assemble")
    assemble_parser.add_argument("--input", type=Path, required=True)
    assemble_parser.add_argument("--chunks", type=Path, required=True)
    assemble_parser.add_argument("--out", type=Path, required=True)
    assemble_parser.add_argument("--view-out", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.command == "prepare":
            if args.chunk_size < 1:
                raise ValueError("--chunk-size 必须大于 0")
            return prepare(args.input, args.chunks_out, args.chunk_size)
        return assemble(args.input, args.chunks, args.out, args.view_out)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
