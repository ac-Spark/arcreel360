import logging
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DraftMode:
    filename: str
    id_header_aliases: set[str]
    segment_field: str
    script_items_key: str
    item_id_key: str


DRAFT_MODES = {
    "narration": DraftMode(
        filename="step1_segments.md",
        id_header_aliases={"片段", "片段 ID", "片段ID", "ID"},
        segment_field="novel_text",
        script_items_key="segments",
        item_id_key="segment_id",
    ),
    "drama": DraftMode(
        filename="step1_normalized_script.md",
        id_header_aliases={"場景 ID", "場景ID", "ID"},
        segment_field="scene_description",
        script_items_key="scenes",
        item_id_key="scene_id",
    ),
}

# 表頭欄位（任一模式）會出現的 ID 欄標題；用於略過表頭列。
_HEADER_ID_LABELS = {"片段", "場景 ID", "片段 ID", "場景ID", "片段ID", "ID"}


def _split_cells(line: str) -> list[str]:
    """切分 Markdown 表格列為 cell 字串，尊重 `\\|` 跳脫。

    回傳含首尾空字串的 raw split（與 ``str.split("|")`` 對齊），呼叫端依需要取用。
    跳脫的 ``\\|`` 會被保留為字面 ``|``（已還原）。
    """
    cells: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(line)
    while i < n:
        ch = line[i]
        if ch == "\\" and i + 1 < n and line[i + 1] == "|":
            buf.append("|")
            i += 2
            continue
        if ch == "|":
            cells.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    cells.append("".join(buf))
    return cells


def _escape_cell(text: str) -> str:
    """把 cell 內容寫回表格前，將字面 ``|`` 跳脫為 ``\\|``。"""
    return text.replace("|", "\\|")


def _is_table_row(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("|") and "---" not in stripped


def parse_draft_table(md: str) -> list[dict]:
    """解析 step1 草稿表格。

    回傳每列 ``{"id", "content", "raw_cells"}``：
    - ``id`` / ``content`` 已還原跳脫，供讀取端直接使用。
    - ``raw_cells`` 為 content 之後的資料欄（同樣已還原），向後相容既有呼叫端。
    """
    rows = []
    for line in md.splitlines():
        if not _is_table_row(line):
            continue
        parts = [p.strip() for p in _split_cells(line.strip())]
        if len(parts) >= 3:
            id_val = parts[1]
            if id_val in _HEADER_ID_LABELS:
                continue
            rows.append({"id": id_val, "content": parts[2], "raw_cells": parts[3:-1]})
    return rows


def render_draft_table(rows: list[dict], mode_name: str) -> str:
    """從 parsed rows 重建表格。

    保留每列原有的資料欄（``raw_cells``，含 ``有對話`` 等模式特有欄位），
    不再硬編固定欄數，避免 round-trip 丟欄／欄位錯位。各 cell 內的 ``|`` 會重新跳脫。
    """
    is_drama = mode_name == "drama"
    id_header = "場景 ID" if is_drama else "片段 ID"
    content_header = "場景描述" if is_drama else "原文"

    # 以最寬的列決定資料欄數，確保表頭欄位齊全。
    max_extra = max((len(row.get("raw_cells", [])) for row in rows), default=0)
    if is_drama:
        extra_headers = ["時長", "場景型別", "segment_break"][:max_extra]
    else:
        extra_headers = ["字數", "時長", "有對話", "segment_break"][:max_extra]
    # 若實際欄數超出已知標題，補上佔位標題保持欄數一致。
    extra_headers += [""] * (max_extra - len(extra_headers))

    headers = [id_header, content_header, *extra_headers]
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join(["---"] * len(headers)) + " |",
    ]
    for row in rows:
        cells = [_escape_cell(c) for c in (row["id"], row["content"], *row.get("raw_cells", []))]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def sync_segment_to_draft(project_path: Path, episode: int, segment_id: str, new_content: str, mode_name: str) -> bool:
    """精準覆蓋草稿表格中指定 segment 的 content 欄，其餘列與欄位逐字保留。

    直接在原始 markdown 上做行內替換，不重建整張表，避免任何 schema 漂移。
    回傳是否確實命中並更新了該 segment（檔案不存在、找不到 id 或寫入失敗皆回傳 False）。
    """
    mode = DRAFT_MODES[mode_name]
    draft_dir = project_path / "drafts" / f"episode_{episode}"
    draft_file = draft_dir / mode.filename
    if not draft_file.exists():
        return False

    try:
        md = draft_file.read_text(encoding="utf-8")
        out_lines: list[str] = []
        updated = False
        for line in md.splitlines():
            if not updated and _is_table_row(line):
                cells = _split_cells(line)
                # cells: ["", id, content, ...extra, ""]（首尾為外側 | 兩端的空字串）
                if len(cells) >= 4 and cells[1].strip() == segment_id:
                    # 保留 content cell 原有的前後空白排版。
                    original = cells[2]
                    lstripped = original.lstrip()
                    lead = original[: len(original) - len(lstripped)]
                    trail = lstripped[len(lstripped.rstrip()) :]
                    cells[2] = f"{lead}{_escape_cell(new_content)}{trail}"
                    line = "|".join(cells)
                    updated = True
            out_lines.append(line)

        if updated:
            new_md = "\n".join(out_lines)
            if md.endswith("\n") and not new_md.endswith("\n"):
                new_md += "\n"
            draft_file.write_text(new_md, encoding="utf-8")
        return updated
    except Exception as e:
        logger.error(f"Sync segment to draft failed: {e}", exc_info=True)
        return False


def sync_draft_to_segments(project_path: Path, episode: int, new_md: str, mode_name: str, manager) -> int:
    mode = DRAFT_MODES[mode_name]
    rows = parse_draft_table(new_md)
    script_filename = f"episode_{episode}.json"

    try:
        script = manager.load_script(project_path.name, script_filename)
    except FileNotFoundError:
        return 0

    items = script.get(mode.script_items_key, [])
    if not items:
        items = script.get("scenes", {})

    updated_count = 0
    content_map = {row["id"]: row["content"] for row in rows}

    if isinstance(items, list):
        for item in items:
            iid = item.get(mode.item_id_key)
            if iid in content_map:
                if item.get(mode.segment_field) != content_map[iid]:
                    item[mode.segment_field] = content_map[iid]
                    updated_count += 1
    elif isinstance(items, dict):
        for iid, item in items.items():
            if iid in content_map:
                if item.get(mode.segment_field) != content_map[iid]:
                    item[mode.segment_field] = content_map[iid]
                    updated_count += 1

    if updated_count > 0:
        manager.save_script(project_path.name, script, script_filename)

    return updated_count
