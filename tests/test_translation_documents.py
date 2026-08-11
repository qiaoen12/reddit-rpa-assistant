from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FINAL_SCRIPT = ROOT / "scripts" / "build_final_documents.py"
TRANSLATION_SCRIPT = ROOT / "scripts" / "build_translation_documents.py"


class TranslationDocumentTests(unittest.TestCase):
    def test_builds_clean_chunks_and_bilingual_view(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "merged.jsonl"
            source.write_text(json.dumps({
                "id": "abc123", "fullname": "t3_abc123", "record_type": "post", "subreddit": "VRGaming",
                "post_id": "abc123", "post_fullname": "t3_abc123", "title": "Hello", "content": "Original text",
                "canonical_url": "https://www.reddit.com/r/VRGaming/comments/abc123/hello/", "captured_at": "2026-08-07T12:00:00.000Z"
            }) + "\n", encoding="utf-8")
            raw_out = root / "raw.ndjson"
            clean_out = root / "clean" / "reddit_clean_for_ai.jsonl"
            subprocess.run([
                sys.executable, str(FINAL_SCRIPT), "--input", str(source), "--raw-out", str(raw_out), "--clean-out", str(clean_out),
                "--collection-name", "VR-XR", "--subreddit", "VRGaming"
            ], check=True)
            chunks = root / "translated" / "chunks"
            subprocess.run([sys.executable, str(TRANSLATION_SCRIPT), "prepare", "--input", str(clean_out), "--chunks-out", str(chunks), "--chunk-size", "1"], check=True)
            chunk = chunks / "001_source.jsonl"
            translated = json.loads(chunk.read_text(encoding="utf-8").strip())
            translated["title_zh"] = "你好"
            translated["content_zh"] = "原文中文"
            chunk.write_text(json.dumps(translated, ensure_ascii=False) + "\n", encoding="utf-8")
            out = root / "translated" / "reddit_translated_for_ai.jsonl"
            view = root / "translated" / "view" / "reddit_translated_view.html"
            subprocess.run([
                sys.executable, str(TRANSLATION_SCRIPT), "assemble", "--input", str(clean_out), "--chunks", str(chunks), "--out", str(out), "--view-out", str(view)
            ], check=True)
            row = json.loads(out.read_text(encoding="utf-8").strip())
            self.assertEqual(row["content_zh"], "原文中文")
            self.assertEqual(row["translation_status"], "translated")
            self.assertIn("原文中文", view.read_text(encoding="utf-8"))
