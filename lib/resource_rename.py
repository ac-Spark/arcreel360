"""resource_rename.py — 角色 / 道具改名（含檔案、版本、劇本引用）

設計目標：
- **原子性**：失敗時 rollback 已搬移的檔案，不留中途狀態
- **完整性**：除了 project.json，所有引用點都要更新（劇本陣列、dialogue.speaker、versions.json、檔案路徑欄位）
- 不直接觸碰 DB；專案資料是檔案系統 + project.json
"""

from __future__ import annotations

import json
import logging
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)

ResourceKind = Literal["character", "clue"]

# 不允許的檔名字元（路徑分隔、保留字元、控制字元）
_INVALID_NAME_RE = re.compile(r'[/\\:\*\?"<>\|\x00-\x1f]')


def _validate_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise ValueError("名稱不可為空")
    if _INVALID_NAME_RE.search(name):
        raise ValueError("名稱包含非法字元（不可有 / \\ : * ? \" < > | 或控制字元）")
    if name in (".", ".."):
        raise ValueError("名稱不可為 . 或 ..")
    if len(name) > 64:
        raise ValueError("名稱過長（最多 64 字元）")
    return name


@dataclass
class _Move:
    """單筆檔案搬移記錄，rollback 用。"""

    src: Path
    dst: Path


@dataclass
class RenameResult:
    files_moved: int
    scripts_updated: int
    versions_updated: int


def rename_resource(
    project_path: Path,
    project: dict,
    kind: ResourceKind,
    old_name: str,
    new_name: str,
) -> RenameResult:
    """改名一個角色或道具。**會直接修改傳入的 project dict**，呼叫者負責 save。

    步驟：
    1. 校驗 new_name 合法 + 不衝突
    2. 收集所有要搬移的檔案（角色設計圖、reference image、版本歷史、道具設計圖）
    3. 預先計算所有目標路徑，檢查衝突
    4. 執行搬移（記錄已搬，失敗時 rollback）
    5. 更新 project.json 的 dict key + 路徑欄位
    6. 更新 versions.json 的字串列表
    7. 掃 scripts/*.json 替換引用
    """
    new_name = _validate_name(new_name)
    if new_name == old_name:
        return RenameResult(0, 0, 0)

    bucket = "characters" if kind == "character" else "clues"
    if old_name not in project.get(bucket, {}):
        raise KeyError(f"{bucket}: {old_name} 不存在")
    if new_name in project.get(bucket, {}):
        raise ValueError(f"{bucket} 中已存在「{new_name}」")

    moves = _plan_moves(project_path, kind, old_name, new_name)

    # 檢查目標檔案不存在（避免覆蓋）
    for mv in moves:
        if mv.dst.exists():
            raise ValueError(f"目標檔案已存在，無法搬移：{mv.dst.relative_to(project_path)}")

    # 執行搬移（出錯 rollback）
    completed: list[_Move] = []
    try:
        for mv in moves:
            mv.dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(mv.src), str(mv.dst))
            completed.append(mv)
    except Exception:
        # rollback
        for mv in reversed(completed):
            try:
                shutil.move(str(mv.dst), str(mv.src))
            except Exception:
                logger.exception("rollback 失敗：%s -> %s", mv.dst, mv.src)
        raise

    # 更新 project dict（原地）
    bucket_dict = project[bucket]
    entry = bucket_dict.pop(old_name)
    sheet_key = "character_sheet" if kind == "character" else "clue_sheet"
    folder = "characters" if kind == "character" else "clues"

    # 更新內部路徑欄位
    if entry.get(sheet_key):
        old_rel = entry[sheet_key]
        if old_rel.startswith(f"{folder}/{old_name}"):
            entry[sheet_key] = old_rel.replace(
                f"{folder}/{old_name}", f"{folder}/{new_name}", 1
            )

    if kind == "character" and entry.get("reference_image"):
        old_rel = entry["reference_image"]
        ref_prefix = "characters/refs/"
        if old_rel.startswith(f"{ref_prefix}{old_name}"):
            entry["reference_image"] = old_rel.replace(
                f"{ref_prefix}{old_name}", f"{ref_prefix}{new_name}", 1
            )

    bucket_dict[new_name] = entry

    # 更新 versions.json（字串列表）
    versions_updated = _update_versions_json(project_path, kind, old_name, new_name)

    # 更新所有 scripts/*.json 引用
    scripts_updated = _update_scripts(project_path, kind, old_name, new_name)

    return RenameResult(
        files_moved=len(completed),
        scripts_updated=scripts_updated,
        versions_updated=versions_updated,
    )


def _plan_moves(
    project_path: Path, kind: ResourceKind, old_name: str, new_name: str
) -> list[_Move]:
    moves: list[_Move] = []
    folder = "characters" if kind == "character" else "clues"

    # 1. 主設計圖 {folder}/{name}.{ext}
    main_dir = project_path / folder
    if main_dir.exists():
        for f in main_dir.glob(f"{old_name}.*"):
            if f.is_file():
                moves.append(_Move(f, main_dir / f"{new_name}{f.suffix}"))

    # 2. 角色 reference 圖 characters/refs/{name}.{ext}
    if kind == "character":
        refs_dir = project_path / "characters" / "refs"
        if refs_dir.exists():
            for f in refs_dir.glob(f"{old_name}.*"):
                if f.is_file():
                    moves.append(_Move(f, refs_dir / f"{new_name}{f.suffix}"))

    # 3. 版本歷史 versions/{folder}/{old_name}_v*.{ext}
    versions_dir = project_path / "versions" / folder
    if versions_dir.exists():
        for f in versions_dir.glob(f"{old_name}_v*"):
            if f.is_file():
                # 只替換開頭的 old_name，保留 _v123_timestamp.ext 部分
                new_filename = new_name + f.name[len(old_name):]
                moves.append(_Move(f, versions_dir / new_filename))

    return moves


def _update_versions_json(
    project_path: Path, kind: ResourceKind, old_name: str, new_name: str
) -> int:
    versions_file = project_path / "versions" / "versions.json"
    if not versions_file.exists():
        return 0

    try:
        data = json.loads(versions_file.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("versions.json 解析失敗，跳過")
        return 0

    bucket = "characters" if kind == "character" else "clues"
    items = data.get(bucket, [])
    if not isinstance(items, list):
        return 0

    updated = 0
    for i, item in enumerate(items):
        if item == old_name:
            items[i] = new_name
            updated += 1

    if updated:
        versions_file.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    return updated


def _update_scripts(
    project_path: Path, kind: ResourceKind, old_name: str, new_name: str
) -> int:
    scripts_dir = project_path / "scripts"
    if not scripts_dir.exists():
        return 0

    list_keys = (
        ["characters_in_segment", "characters_in_scene"]
        if kind == "character"
        else ["clues_in_segment", "clues_in_scene"]
    )

    updated_files = 0
    for script_file in scripts_dir.glob("*.json"):
        try:
            script = json.loads(script_file.read_text(encoding="utf-8"))
        except Exception:
            logger.warning("跳過解析失敗的劇本: %s", script_file.name)
            continue

        changed = False
        # narration: segments / drama: scenes
        items = script.get("segments") or script.get("scenes") or []
        for item in items:
            for key in list_keys:
                arr = item.get(key)
                if isinstance(arr, list):
                    new_arr = [new_name if x == old_name else x for x in arr]
                    if new_arr != arr:
                        item[key] = new_arr
                        changed = True

            # dialogue.speaker（只有 character 改名才需要）
            if kind == "character":
                vp = item.get("video_prompt")
                if isinstance(vp, dict):
                    dialogue = vp.get("dialogue")
                    if isinstance(dialogue, list):
                        for d in dialogue:
                            if isinstance(d, dict) and d.get("speaker") == old_name:
                                d["speaker"] = new_name
                                changed = True

        if changed:
            script_file.write_text(
                json.dumps(script, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            updated_files += 1

    return updated_files
