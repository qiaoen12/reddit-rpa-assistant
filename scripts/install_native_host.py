#!/usr/bin/env python3
"""Install the local Native Messaging manifest for one unpacked Chrome extension ID."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path


HOST_NAME = "com.openai.reddit_rpa"


def main() -> int:
    parser = argparse.ArgumentParser(description="安装 Reddit RPA Native Messaging Host（macOS Chrome）")
    parser.add_argument("--extension-id", required=True, help="chrome://extensions 中此已解压扩展的 ID")
    parser.add_argument("--manifest-dir", type=Path, default=Path.home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts")
    args = parser.parse_args()
    extension_id = args.extension_id.strip()
    if not re.fullmatch(r"[a-p]{32}", extension_id):
        parser.error("extension ID 必须是 Chrome 的 32 位 a-p 字符串。")
    extension_root = Path(__file__).resolve().parents[1]
    host_script = extension_root / "native-host" / "reddit_rpa_native_host.py"
    if not host_script.is_file():
        parser.error(f"Native Host 脚本不存在：{host_script}")
    host_script.chmod(host_script.stat().st_mode | 0o111)
    manifest = {
        "name": HOST_NAME,
        "description": "Reddit RPA local collection host",
        "path": str(host_script),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }
    target = args.manifest_dir.expanduser() / f"{HOST_NAME}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, target)
    print(json.dumps({"ok": True, "manifest": str(target), "host_script": str(host_script), "extension_id": extension_id}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
