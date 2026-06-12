from unittest.mock import MagicMock

from lib.step1_draft_sync import parse_draft_table, render_draft_table, sync_draft_to_segments, sync_segment_to_draft

# 真實 narration 表格為 6 欄：片段 | 原文 | 字數 | 時長 | 有對話 | segment_break
REAL_NARRATION_MD = (
    "## 片段拆分結果\n\n"
    "| 片段 | 原文 | 字數 | 時長 | 有對話 | segment_break |\n"
    "|------|------|------|------|--------|---------------|\n"
    "| G01 | 鎏金城的晨光總是帶著一股矛盾的氣息。 | 17 | 4s | 否 | - |\n"
    "| G02 | 東邊的貴族區飄來甜膩的燻香。 | 13 | 8s | 是 | - |\n"
)


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
    # 原始欄位應逐字保留，不重算字數。
    assert "| 7 |" in rendered


def test_parse_preserves_six_column_cells():
    rows = parse_draft_table(REAL_NARRATION_MD)
    assert len(rows) == 2
    assert rows[0]["id"] == "G01"
    assert rows[0]["content"] == "鎏金城的晨光總是帶著一股矛盾的氣息。"
    # raw_cells 應保留 字數 / 時長 / 有對話 / segment_break 四欄。
    assert rows[0]["raw_cells"] == ["17", "4s", "否", "-"]


def test_render_preserves_dialogue_column():
    rows = parse_draft_table(REAL_NARRATION_MD)
    rendered = render_draft_table(rows, "narration")
    # 「有對話」欄與其表頭必須保留，不可被丟欄或寫進 segment_break。
    assert "有對話" in rendered
    rerows = parse_draft_table(rendered)
    assert rerows[0]["raw_cells"] == ["17", "4s", "否", "-"]
    assert rerows[1]["raw_cells"] == ["13", "8s", "是", "-"]


def test_sync_segment_preserves_other_columns(tmp_path):
    draft_dir = tmp_path / "drafts" / "episode_1"
    draft_dir.mkdir(parents=True)
    draft_file = draft_dir / "step1_segments.md"
    draft_file.write_text(REAL_NARRATION_MD, encoding="utf-8")

    sync_segment_to_draft(tmp_path, 1, "G01", "全新的原文內容", "narration")

    new_md = draft_file.read_text(encoding="utf-8")
    assert "全新的原文內容" in new_md
    rows = parse_draft_table(new_md)
    # 被改列：content 換新，其餘欄位（字數/時長/有對話/segment_break）逐字保留。
    assert rows[0]["content"] == "全新的原文內容"
    assert rows[0]["raw_cells"] == ["17", "4s", "否", "-"]
    # 未改列：完全不動。
    assert rows[1]["content"] == "東邊的貴族區飄來甜膩的燻香。"
    assert rows[1]["raw_cells"] == ["13", "8s", "是", "-"]
    # 表頭保留「有對話」。
    assert "有對話" in new_md


def test_sync_segment_handles_escaped_pipe(tmp_path):
    draft_dir = tmp_path / "drafts" / "episode_1"
    draft_dir.mkdir(parents=True)
    draft_file = draft_dir / "step1_segments.md"
    draft_file.write_text(REAL_NARRATION_MD, encoding="utf-8")

    # 新內容含字面 | ，寫回時應跳脫，讀回時還原。
    sync_segment_to_draft(tmp_path, 1, "G02", "他說：是A|還是B？", "narration")

    new_md = draft_file.read_text(encoding="utf-8")
    assert "A\\|還是B" in new_md  # 檔案中為跳脫形式
    rows = parse_draft_table(new_md)
    assert rows[1]["content"] == "他說：是A|還是B？"  # 解析後還原
    assert rows[1]["raw_cells"] == ["13", "8s", "是", "-"]


def test_sync_segment_drama_five_column(tmp_path):
    draft_dir = tmp_path / "drafts" / "episode_1"
    draft_dir.mkdir(parents=True)
    draft_file = draft_dir / "step1_normalized_script.md"
    draft_file.write_text(
        "| 場景 ID | 場景描述 | 時長 | 場景型別 | segment_break |\n"
        "|---|---|---|---|---|\n"
        "| E1S01 | 舊場景描述 | 8 | 劇情 | 是 |\n"
        "| E1S02 | 另一場景 | 8 | 對話 | 否 |\n",
        encoding="utf-8",
    )

    sync_segment_to_draft(tmp_path, 1, "E1S01", "新場景描述", "drama")

    rows = parse_draft_table(draft_file.read_text(encoding="utf-8"))
    assert rows[0]["content"] == "新場景描述"
    assert rows[0]["raw_cells"] == ["8", "劇情", "是"]
    assert rows[1]["content"] == "另一場景"


def test_sync_draft_to_segments(tmp_path):
    manager = MagicMock()

    script_data = {
        "content_mode": "narration",
        "segments": [{"segment_id": "G01", "novel_text": "舊文字"}, {"segment_id": "G02", "novel_text": "無變化"}],
    }
    manager.load_script.return_value = script_data

    new_md = (
        "| 片段 ID | 原文 | 字數 | 時長 | segment_break |\n"
        "|---|---|---|---|---|\n"
        "| G01 | 改過的文字 | 5 | 4 | True |\n"
        "| G02 | 無變化 | 3 | 4 | False |\n"
    )

    sync_draft_to_segments(tmp_path, 1, new_md, "narration", manager)

    manager.load_script.assert_called_once_with(tmp_path.name, "episode_1.json")

    manager.save_script.assert_called_once()
    saved_script = manager.save_script.call_args[0][1]
    assert saved_script["segments"][0]["novel_text"] == "改過的文字"
    assert saved_script["segments"][1]["novel_text"] == "無變化"
