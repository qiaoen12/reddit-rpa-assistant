#!/usr/bin/env python3
"""Reddit RPA 的薄控制面：写命令信箱，读取批次与事件日志。

此脚本不连接 Chrome、不调用 Reddit，也不会改写 raw-v2 的采集文件。
唯一的写入是 VR-XR/.reddit-rpa-control/ 下的请求文件；当前唯一 Reddit
工作页读取该请求并执行既有 DOM 采集路径。Native Host 已安装时由它回写
控制响应与采集数据，未安装时保留 File System Access 回退路径。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CONTROL_DIRECTORY = ".reddit-rpa-control"
REQUEST_SCHEMA = "reddit-rpa-control-request-v1"
RESPONSE_SCHEMA = "reddit-rpa-control-response-v1"
COLLECTOR_SCHEMA = "reddit-rpa-collector-v1"
COMMANDS = {"prepare", "run", "pause", "resume", "cancel"}
TERMINAL_STATUSES = {"complete", "tree_partial", "manual", "failed", "interrupted"}
COLLECTOR_HEARTBEAT_MAX_AGE_SECONDS = 90


class ControlError(RuntimeError):
    """A request or local collection layout is invalid."""


def default_root() -> Path:
    return Path(__file__).resolve().parents[3] / "VR-XR"


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def control_paths(root: Path) -> dict[str, Path]:
    control = root / CONTROL_DIRECTORY
    return {
        "root": control,
        "requests": control / "requests",
        "responses": control / "responses",
        "collectors": control / "collectors",
    }


def read_json(path: Path, *, optional: bool = False) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        if optional:
            return None
        raise ControlError(f"文件不存在：{path}") from None
    except json.JSONDecodeError as error:
        raise ControlError(f"JSON 无效：{path}（{error.msg}）") from error


def json_lines(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as error:
            raise ControlError(f"JSONL 无效：{path}:{line_number}（{error.msg}）") from error
        if isinstance(parsed, dict):
            rows.append(parsed)
    return rows


def registry_subreddits(root: Path) -> dict[str, dict[str, Any]]:
    registry = read_json(root / "rules" / "subreddit_registry.json")
    entries = registry.get("subreddits") if isinstance(registry, dict) else None
    if not isinstance(entries, list):
        raise ControlError("rules/subreddit_registry.json 缺少 subreddits 列表。")
    result: dict[str, dict[str, Any]] = {}
    for item in entries:
        if not isinstance(item, dict):
            continue
        canonical = str(item.get("canonicalName") or item.get("subreddit") or "").strip().lower()
        if canonical:
            result[canonical] = item
    return result


def registered_subreddit(root: Path, subreddit: str) -> dict[str, Any]:
    name = str(subreddit or "").strip()
    if not name or not name.replace("_", "a").isalnum():
        raise ControlError("subreddit 只能包含字母、数字或下划线。")
    entry = registry_subreddits(root).get(name.lower())
    if not entry:
        raise ControlError(f"subreddit 不在登记表中：{name}")
    return entry


def valid_batch_id(batch_id: str) -> bool:
    return bool(batch_id) and all(char.isalnum() or char in "_.-" for char in batch_id)


def valid_collector_id(collector_id: str | None) -> bool:
    return valid_batch_id(str(collector_id or ""))


def make_request(command: str, *, subreddit: str | None = None, count: int | None = None, batch_id: str | None = None, collector_id: str | None = None) -> dict[str, Any]:
    if command not in COMMANDS:
        raise ControlError(f"不支持的控制命令：{command}")
    request: dict[str, Any] = {
        "schema": REQUEST_SCHEMA,
        "request_id": f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:10]}",
        "command": command,
        "created_at": iso_now(),
    }
    if subreddit is not None:
        request["subreddit"] = subreddit
    if count is not None:
        request["count"] = count
    if batch_id is not None:
        request["batch_id"] = batch_id
    if collector_id is not None:
        request["collector_id"] = collector_id
    return request


def validate_request(root: Path, request: dict[str, Any]) -> dict[str, Any]:
    if request.get("schema") != REQUEST_SCHEMA:
        raise ControlError("控制请求 schema 不匹配。")
    command = str(request.get("command") or "")
    if command not in COMMANDS:
        raise ControlError(f"不支持的控制命令：{command}")
    request_id = str(request.get("request_id") or "")
    if not valid_batch_id(request_id):
        raise ControlError("request_id 无效。")
    if request.get("collector_id") is not None and not valid_collector_id(str(request.get("collector_id"))):
        raise ControlError("collector_id 无效。")
    if command in {"prepare", "run"}:
        entry = registered_subreddit(root, str(request.get("subreddit") or ""))
        request["subreddit"] = entry["subreddit"]
    if command == "run":
        count = request.get("count")
        if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 50:
            raise ControlError("count 必须是 1 到 50 之间的整数。")
    if command in {"pause", "resume", "cancel"}:
        batch_id = str(request.get("batch_id") or "")
        if not valid_batch_id(batch_id):
            raise ControlError("batch_id 无效。")
    return request


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink(missing_ok=True)


def parsed_time(value: Any) -> float | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def collector_snapshots(root: Path) -> list[dict[str, Any]]:
    snapshots: list[dict[str, Any]] = []
    for path in sorted(control_paths(root)["collectors"].glob("*.json")):
        snapshot = read_json(path, optional=True)
        if not isinstance(snapshot, dict) or snapshot.get("schema") != COLLECTOR_SCHEMA:
            continue
        collector_id = str(snapshot.get("collector_id") or "")
        seen_at = parsed_time(snapshot.get("seen_at"))
        if not valid_collector_id(collector_id) or seen_at is None:
            continue
        snapshots.append({**snapshot, "collector_id": collector_id, "seen_timestamp": seen_at})
    return snapshots


def control_health(root: Path, collector_id: str | None = None) -> dict[str, Any]:
    requested = str(collector_id or "").strip() or None
    if requested is not None and not valid_collector_id(requested):
        raise ControlError("collector_id 无效。")
    snapshots = collector_snapshots(root)
    now_timestamp = time.time()
    fresh = [snapshot for snapshot in snapshots if now_timestamp - snapshot["seen_timestamp"] <= COLLECTOR_HEARTBEAT_MAX_AGE_SECONDS]
    if requested:
        matching = [snapshot for snapshot in snapshots if snapshot["collector_id"] == requested]
        if not matching:
            return {"ok": False, "code": "COLLECTOR_NOT_FOUND", "error": "指定采集器未注册 Native Host 状态。", "collector_id": requested}
        snapshot = matching[0]
        if snapshot not in fresh:
            return {"ok": False, "code": "COLLECTOR_OFFLINE", "error": "指定采集器超过 90 秒未心跳；请确认 Chrome 与扩展仍在运行。", "collector_id": requested}
        return {"ok": True, "status": "collector_ready", "collector": snapshot}
    if not snapshots:
        return {"ok": False, "code": "NATIVE_HOST_REQUIRED", "error": "没有已连接的 Native Host 采集器。请完成一次 Host 安装并重载扩展。"}
    if not fresh:
        return {"ok": False, "code": "COLLECTOR_OFFLINE", "error": "Native Host 采集器超过 90 秒未心跳；请确认 Chrome 与扩展仍在运行。"}
    if len(fresh) > 1:
        return {"ok": False, "code": "COLLECTOR_SELECTION_REQUIRED", "error": "发现多个在线采集器；请显式指定 collector_id。", "collectors": fresh}
    return {"ok": True, "status": "collector_ready", "collector": fresh[0]}


def submit_request(root: Path, request: dict[str, Any], *, timeout_seconds: float = 30.0) -> dict[str, Any]:
    request = validate_request(root, dict(request))
    health = control_health(root, request.get("collector_id"))
    if not health.get("ok"):
        return health
    request["collector_id"] = health["collector"]["collector_id"]
    paths = control_paths(root)
    request_path = paths["requests"] / f"{request['request_id']}.json"
    response_path = paths["responses"] / f"{request['request_id']}.json"
    if request_path.exists() or response_path.exists():
        raise ControlError(f"request_id 已存在：{request['request_id']}")
    atomic_write_json(request_path, request)
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    while time.monotonic() <= deadline:
        response = read_json(response_path, optional=True)
        if response is not None:
            return response
        time.sleep(0.25)
    return {
        "schema": RESPONSE_SCHEMA,
        "request_id": request["request_id"],
        "command": request["command"],
        "collector_id": request["collector_id"],
        "ok": False,
        "code": "COLLECTOR_UNRESPONSIVE",
        "error": "Native Host 采集器在线但未在期限内处理命令；请调用 health 检查采集器状态后再重试。",
    }


def batch_path(root: Path, batch_id: str) -> Path:
    if not valid_batch_id(batch_id):
        raise ControlError("batch_id 无效。")
    return root / "raw-v2" / "batches" / f"{batch_id}.json"


def batch_status(root: Path, batch_id: str) -> dict[str, Any]:
    batch = read_json(batch_path(root, batch_id))
    targets = batch.get("targets") if isinstance(batch, dict) else []
    if not isinstance(targets, list):
        raise ControlError("batch.json 缺少 targets 列表。")
    counts: dict[str, int] = {}
    for target in targets:
        status = str(target.get("status") or "unknown") if isinstance(target, dict) else "unknown"
        counts[status] = counts.get(status, 0) + 1
    return {
        "ok": True,
        "status": "batch_status",
        "batch_id": batch.get("batch_id"),
        "subreddit": batch.get("subreddit"),
        "active": bool(batch.get("active")),
        "paused": bool(batch.get("paused")),
        "cancelled": bool(batch.get("cancelled")),
        "selected_count": int(batch.get("selected_count") or 0),
        "target_status_counts": counts,
        "started_at": batch.get("started_at"),
        "completed_at": batch.get("completed_at"),
        "integrity": batch.get("integrity"),
    }


def tail_events(root: Path, batch_id: str, *, limit: int = 20) -> dict[str, Any]:
    events = json_lines(root / "raw-v2" / "batches" / f"{batch_id}.events.jsonl")
    return {
        "ok": True,
        "status": "batch_events",
        "batch_id": batch_id,
        "event_count": len(events),
        "events": events[-max(1, limit):],
    }


def verify_batch(root: Path, batch_id: str) -> dict[str, Any]:
    batch = read_json(batch_path(root, batch_id))
    targets = [target for target in batch.get("targets", []) if isinstance(target, dict)]
    terminal = [target for target in targets if str(target.get("status") or "") in TERMINAL_STATUSES]
    layer = root / "raw-v2"
    owners: dict[str, str] = {}
    duplicate_ids: set[str] = set()
    self_parent_count = 0
    mismatched_post_count = 0
    gap_count = 0
    post_directory_count = 0
    comment_count = 0
    if layer.exists():
        for subreddit_dir in sorted(layer.iterdir()):
            if not subreddit_dir.is_dir() or subreddit_dir.name == "batches":
                continue
            for post_dir in sorted(subreddit_dir.iterdir()):
                if not post_dir.is_dir():
                    continue
                post = read_json(post_dir / "post.json", optional=True)
                if not isinstance(post, dict):
                    continue
                post_directory_count += 1
                post_fullname = ((post.get("post") or {}).get("fullname")) if isinstance(post.get("post"), dict) else None
                location = f"{subreddit_dir.name}/{post_dir.name}"
                comments = json_lines(post_dir / "comments.jsonl")
                for comment in comments:
                    if comment.get("record_type") != "comment" or not comment.get("fullname"):
                        continue
                    comment_count += 1
                    fullname = str(comment["fullname"])
                    if fullname in owners:
                        duplicate_ids.add(fullname)
                    else:
                        owners[fullname] = location
                    if comment.get("parent_fullname") == fullname:
                        self_parent_count += 1
                    if not post_fullname or comment.get("post_fullname") != post_fullname:
                        mismatched_post_count += 1
                captures = json_lines(post_dir / "captures.jsonl")
                if captures and int(captures[-1].get("comment_count_gap") or 0) > 0:
                    gap_count += 1
    selected_count = int(batch.get("selected_count") or 0)
    result = {
        "ok": selected_count == len(terminal) and not duplicate_ids and not self_parent_count and not mismatched_post_count,
        "status": "batch_verified",
        "batch_id": batch.get("batch_id"),
        "selected_count": selected_count,
        "terminal_target_count": len(terminal),
        "unresolved_target_count": len(targets) - len(terminal),
        "post_directory_count": post_directory_count,
        "checked_comment_count": comment_count,
        "duplicate_comment_count": len(duplicate_ids),
        "duplicate_comment_ids": sorted(duplicate_ids)[:20],
        "self_parent_count": self_parent_count,
        "mismatched_post_count": mismatched_post_count,
        "latest_capture_gap_count": gap_count,
    }
    return result


def wait_for_started_batch(root: Path, subreddit: str, not_before: float, timeout_seconds: float) -> dict[str, Any] | None:
    directory = root / "raw-v2" / "batches"
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    while time.monotonic() <= deadline:
        if directory.exists():
            candidates = sorted(directory.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
            for path in candidates:
                if path.stat().st_mtime + 1 < not_before:
                    continue
                batch = read_json(path, optional=True)
                if isinstance(batch, dict) and str(batch.get("subreddit") or "").lower() == subreddit.lower():
                    return batch_status(root, str(batch.get("batch_id") or ""))
        time.sleep(0.5)
    return None


def command_result(root: Path, args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "health":
        return control_health(root, args.collector_id)
    if args.command == "status":
        return batch_status(root, args.batch_id)
    if args.command == "tail":
        return tail_events(root, args.batch_id, limit=args.limit)
    if args.command == "verify":
        return verify_batch(root, args.batch_id)

    if args.command == "run":
        entry = registered_subreddit(root, args.subreddit)
        started = time.time()
        response = submit_request(root, make_request("run", subreddit=entry["subreddit"], count=args.count, collector_id=args.collector_id), timeout_seconds=args.timeout)
        if not response.get("ok"):
            return response
        if response.get("status") == "control_preparing":
            batch = wait_for_started_batch(root, entry["subreddit"], started, args.timeout)
            if batch:
                return {"ok": True, "status": "batch_started", "control": response, "batch": batch}
            return {"ok": False, "code": "CONTROL_BATCH_NOT_STARTED", "error": "工作页已导航，但还没有发现新的 batch.json。", "control": response}
        return response

    if args.command == "prepare":
        entry = registered_subreddit(root, args.subreddit)
        return submit_request(root, make_request("prepare", subreddit=entry["subreddit"], collector_id=args.collector_id), timeout_seconds=args.timeout)

    request = make_request(args.command, batch_id=args.batch_id, collector_id=args.collector_id)
    return submit_request(root, request, timeout_seconds=args.timeout)


def parser() -> argparse.ArgumentParser:
    argument_parser = argparse.ArgumentParser(description="Reddit RPA 薄控制面（不直接写入采集数据）")
    argument_parser.add_argument("--root", type=Path, default=default_root(), help="VR-XR 集合目录")
    argument_parser.add_argument("--timeout", type=float, default=45.0, help="等待 Chrome 工作页响应的秒数")
    argument_parser.add_argument("--collector", dest="collector_id", help="指定 Native Host 采集器；多采集器时必填")
    subparsers = argument_parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "run"):
        command = subparsers.add_parser(name)
        command.add_argument("--subreddit", required=True)
        if name == "run":
            command.add_argument("--count", type=int, default=25)
    subparsers.add_parser("health")
    for name in ("pause", "resume", "cancel", "status", "tail", "verify"):
        command = subparsers.add_parser(name)
        command.add_argument("--batch", dest="batch_id", required=True)
        if name == "tail":
            command.add_argument("--limit", type=int, default=20)
    return argument_parser


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    root = args.root.expanduser().resolve()
    try:
        result = command_result(root, args)
    except ControlError as error:
        result = {"ok": False, "code": "CONTROL_INPUT_INVALID", "error": str(error)}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
