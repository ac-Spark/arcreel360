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


def parse_draft_table(md: str) -> list[dict]:
    rows = []
    lines = md.splitlines()
    for line in lines:
        line = line.strip()
        if not line.startswith("|") or "---" in line:
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) >= 3:
            id_val = parts[1]
            if id_val in {"片段", "場景 ID", "片段 ID", "場景ID", "片段ID", "ID"}:
                continue
            rows.append({"id": id_val, "content": parts[2], "raw_cells": parts[3:-1]})
    return rows


def render_draft_table(rows: list[dict], mode_name: str) -> str:
    is_drama = mode_name == "drama"
    id_header = "場景 ID" if is_drama else "片段 ID"
    content_header = "場景描述" if is_drama else "原文"

    headers = [id_header, content_header, "字數", "時長", "segment_break"]
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for row in rows:
        content = row["content"]
        char_count = str(len(content))
        raw = row["raw_cells"]
        duration = raw[1] if len(raw) > 1 else "4"
        seg_break = raw[2] if len(raw) > 2 else "False"

        cells = [row["id"], content, char_count, duration, seg_break]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def sync_segment_to_draft(project_path: Path, episode: int, segment_id: str, new_content: str, mode_name: str) -> None:
    mode = DRAFT_MODES[mode_name]
    draft_dir = project_path / "drafts" / f"episode_{episode}"
    draft_file = draft_dir / mode.filename
    if not draft_file.exists():
        return

    try:
        md = draft_file.read_text(encoding="utf-8")
        rows = parse_draft_table(md)
        updated = False
        for row in rows:
            if row["id"] == segment_id:
                row["content"] = new_content
                updated = True
                break
        if updated:
            new_md = render_draft_table(rows, mode_name)
            draft_file.write_text(new_md, encoding="utf-8")
    except Exception as e:
        logger.error(f"Sync segment to draft failed: {e}", exc_info=True)


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
