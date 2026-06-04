import pytest
from pathlib import Path
from unittest.mock import MagicMock
from lib.step1_draft_sync import parse_draft_table, render_draft_table, sync_segment_to_draft, sync_draft_to_segments

def test_parse_and_render_roundtrip():
    md_content = (
        "| 片段 ID | 原文 | 字數 | 時長 | segment_break |\n"
        "|---|---|---|---|---|\n"
        "| G01 | 測試內容第一行 | 7 | 4 | True |\n"
        "| G02 | 測試內容第二行 | 7 | 4 | False |\n"
    )
    rows = parse_draft_table(md_content)
    assert len(rows) == 2
    assert rows[0]["id"] == "G01"
    assert rows[0]["content"] == "測試內容第一行"

    rendered = render_draft_table(rows, "narration")
    assert "測試內容第一行" in rendered
    assert "| 7 |" in rendered  # 長度應正確重新計算

def test_sync_segment_to_draft(tmp_path):
    # 建立草稿目錄與檔案
    draft_dir = tmp_path / "drafts" / "episode_1"
    draft_dir.mkdir(parents=True)
    draft_file = draft_dir / "step1_segments.md"
    draft_file.write_text(
        "| 片段 ID | 原文 | 字數 | 時長 | segment_break |\n"
        "|---|---|---|---|---|\n"
        "| G01 | 舊內容 | 3 | 4 | True |\n"
        "| G02 | 其它 | 2 | 4 | False |\n",
        encoding="utf-8"
    )
    
    sync_segment_to_draft(tmp_path, 1, "G01", "新內容阿", "narration")
    
    new_content = draft_file.read_text(encoding="utf-8")
    assert "新內容阿" in new_content
    # 字數應更新為 4
    assert "| G01 | 新內容阿 | 4 | 4 | True |" in new_content

def test_sync_draft_to_segments(tmp_path):
    # 建立 mock manager
    manager = MagicMock()
    
    # 模擬 load_script 回傳的 script
    script_data = {
        "content_mode": "narration",
        "segments": [
            {"segment_id": "G01", "novel_text": "舊文字"},
            {"segment_id": "G02", "novel_text": "無變化"}
        ]
    }
    manager.load_script.return_value = script_data
    
    new_md = (
        "| 片段 ID | 原文 | 字數 | 時長 | segment_break |\n"
        "|---|---|---|---|---|\n"
        "| G01 | 改過的文字 | 5 | 4 | True |\n"
        "| G02 | 無變化 | 3 | 4 | False |\n"
    )
    
    sync_draft_to_segments(tmp_path, 1, new_md, "narration", manager)
    
    # 驗證 load_script 參數
    manager.load_script.assert_called_once_with(tmp_path.name, "episode_1.json")
    
    # 驗證 save_script 被呼叫，且內容被修改
    manager.save_script.assert_called_once()
    saved_script = manager.save_script.call_args[0][1]
    assert saved_script["segments"][0]["novel_text"] == "改過的文字"
    assert saved_script["segments"][1]["novel_text"] == "無變化"
