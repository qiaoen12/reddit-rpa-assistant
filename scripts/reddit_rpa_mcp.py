#!/usr/bin/env python3
"""Small stdio MCP wrapper for reddit_rpa_control.py.

It deliberately contains no browser, API, credential, or data-writing logic.
The Chrome extension remains the sole DOM collector; the optional Native Host
performs fixed-root raw writes.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from reddit_rpa_control import ControlError, command_result, default_root


SERVER_INFO = {"name": "reddit-rpa-control", "version": "0.8.0"}
TOOLS = [
    {
        "name": "reddit_rpa_health",
        "description": "只读检查 Native Host 采集器心跳；无 Computer Use 调用前先使用它。",
        "inputSchema": {"type": "object", "properties": {"collector_id": {"type": "string"}, "root": {"type": "string"}}},
    },
    {
        "name": "reddit_rpa_prepare",
        "description": "由已在线 Native Host 采集器准备指定 subreddit 的唯一 Reddit 工作页 /new/ 列表页。",
        "inputSchema": {"type": "object", "properties": {"subreddit": {"type": "string"}, "collector_id": {"type": "string"}, "timeout": {"type": "number"}, "root": {"type": "string"}}, "required": ["subreddit"]},
    },
    {
        "name": "reddit_rpa_run",
        "description": "一次启动列表同步和固定数量的帖子评论采集；Chrome 扩展仍是唯一 DOM 采集器。",
        "inputSchema": {"type": "object", "properties": {"subreddit": {"type": "string"}, "count": {"type": "integer", "minimum": 1, "maximum": 50}, "collector_id": {"type": "string"}, "timeout": {"type": "number"}, "root": {"type": "string"}}, "required": ["subreddit"]},
    },
    {
        "name": "reddit_rpa_pause",
        "description": "暂停当前批次，不删除已落盘数据。",
        "inputSchema": {"type": "object", "properties": {"batch_id": {"type": "string"}, "collector_id": {"type": "string"}, "timeout": {"type": "number"}, "root": {"type": "string"}}, "required": ["batch_id"]},
    },
    {
        "name": "reddit_rpa_resume",
        "description": "恢复当前唯一工作页拥有的批次。",
        "inputSchema": {"type": "object", "properties": {"batch_id": {"type": "string"}, "collector_id": {"type": "string"}, "timeout": {"type": "number"}, "root": {"type": "string"}}, "required": ["batch_id"]},
    },
    {
        "name": "reddit_rpa_cancel",
        "description": "结束当前批次，只标记未完成目标，不删除已有帖子或评论。",
        "inputSchema": {"type": "object", "properties": {"batch_id": {"type": "string"}, "collector_id": {"type": "string"}, "timeout": {"type": "number"}, "root": {"type": "string"}}, "required": ["batch_id"]},
    },
    {
        "name": "reddit_rpa_status",
        "description": "只读 batch.json，返回批次结构化状态。",
        "inputSchema": {"type": "object", "properties": {"batch_id": {"type": "string"}, "root": {"type": "string"}}, "required": ["batch_id"]},
    },
    {
        "name": "reddit_rpa_tail",
        "description": "只读最近批次事件日志。",
        "inputSchema": {"type": "object", "properties": {"batch_id": {"type": "string"}, "limit": {"type": "integer"}, "root": {"type": "string"}}, "required": ["batch_id"]},
    },
    {
        "name": "reddit_rpa_verify",
        "description": "只读校验批次终态、跨帖重复、自指父级、错帖与数量缺口。",
        "inputSchema": {"type": "object", "properties": {"batch_id": {"type": "string"}, "root": {"type": "string"}}, "required": ["batch_id"]},
    },
]


def response(request_id: Any, result: Any = None, error: dict[str, Any] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
    if error is not None:
        payload["error"] = error
    else:
        payload["result"] = result
    return payload


def tool_result(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False, indent=2)}],
        "structuredContent": value,
        "isError": not bool(value.get("ok")),
    }


def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    command_by_tool = {
        "reddit_rpa_health": "health",
        "reddit_rpa_prepare": "prepare",
        "reddit_rpa_run": "run",
        "reddit_rpa_pause": "pause",
        "reddit_rpa_resume": "resume",
        "reddit_rpa_cancel": "cancel",
        "reddit_rpa_status": "status",
        "reddit_rpa_tail": "tail",
        "reddit_rpa_verify": "verify",
    }
    command = command_by_tool.get(name)
    if not command:
        return {"ok": False, "code": "UNKNOWN_TOOL", "error": f"未知 MCP 工具：{name}"}
    root = Path(str(arguments.get("root") or default_root())).expanduser().resolve()
    namespace = SimpleNamespace(
        command=command,
        root=root,
        timeout=float(arguments.get("timeout", 60.0)),
        collector_id=arguments.get("collector_id"),
        subreddit=arguments.get("subreddit"),
        count=arguments.get("count", 25),
        batch_id=arguments.get("batch_id"),
        limit=int(arguments.get("limit", 20)),
    )
    try:
        return command_result(root, namespace)
    except ControlError as error:
        return {"ok": False, "code": "CONTROL_INPUT_INVALID", "error": str(error)}


def handle(message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method")
    request_id = message.get("id")
    if method == "notifications/initialized":
        return None
    if method == "initialize":
        return response(request_id, {
            "protocolVersion": message.get("params", {}).get("protocolVersion", "2025-03-26"),
            "capabilities": {"tools": {}},
            "serverInfo": SERVER_INFO,
        })
    if method == "tools/list":
        return response(request_id, {"tools": TOOLS})
    if method == "tools/call":
        params = message.get("params") or {}
        result = call_tool(str(params.get("name") or ""), params.get("arguments") or {})
        return response(request_id, tool_result(result))
    return response(request_id, error={"code": -32601, "message": f"Method not found: {method}"})


def main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            message = json.loads(line)
            result = handle(message)
            if result is not None:
                print(json.dumps(result, ensure_ascii=False), flush=True)
        except Exception as error:  # Protocol boundary: return a valid JSON-RPC error.
            print(json.dumps(response(None, error={"code": -32603, "message": str(error)}), ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
