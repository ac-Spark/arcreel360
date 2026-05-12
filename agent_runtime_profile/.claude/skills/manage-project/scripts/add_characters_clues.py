#!/usr/bin/env python3
"""
add_characters_clues.py - 批次新增角色/線索到 project.json

用法（需從專案目錄內執行，必須單行）:
    python .claude/skills/manage-project/scripts/add_characters_clues.py --characters '{"角色名": {"description": "...", "voice_style": "..."}}' --clues '{"線索名": {"type": "prop", "description": "...", "importance": "major"}}'
"""

import argparse
import json
import sys
from pathlib import Path

# 允許從倉庫任意工作目錄直接執行該指令碼
PROJECT_ROOT = (
    Path(__file__).resolve().parents[5]
)  # agent_runtime_profile/.claude/skills/manage-project/scripts -> repo root
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from lib.data_validator import validate_project
from lib.project_manager import ProjectManager


def main():
    parser = argparse.ArgumentParser(
        description="批次新增角色/線索到 project.json",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例（需從專案目錄內執行，必須單行）:
    %(prog)s --characters '{"李白": {"description": "白衣劍客", "voice_style": "豪放"}}'
    %(prog)s --clues '{"玉佩": {"type": "prop", "description": "溫潤白玉", "importance": "major"}}'
        """,
    )

    parser.add_argument(
        "--characters",
        type=str,
        default=None,
        help="JSON 格式的角色資料",
    )
    parser.add_argument(
        "--clues",
        type=str,
        default=None,
        help="JSON 格式的線索資料",
    )
    parser.add_argument(
        "--stdin",
        action="store_true",
        help="從 stdin 讀取 JSON（包含 characters 和/或 clues 欄位）",
    )

    args = parser.parse_args()

    characters = {}
    clues = {}

    if args.stdin:
        stdin_data = json.loads(sys.stdin.read())
        characters = stdin_data.get("characters", {})
        clues = stdin_data.get("clues", {})
    else:
        if args.characters:
            characters = json.loads(args.characters)
        if args.clues:
            clues = json.loads(args.clues)

    if not characters and not clues:
        print("❌ 未提供角色或線索資料")
        sys.exit(1)

    pm, project_name = ProjectManager.from_cwd()

    # 新增角色
    chars_added = 0
    chars_skipped = 0
    if characters:
        project = pm.load_project(project_name)
        existing = project.get("characters", {})
        chars_skipped = sum(1 for name in characters if name in existing)
        chars_added = pm.add_characters_batch(project_name, characters)
        print(f"角色: 新增 {chars_added} 個，跳過 {chars_skipped} 個（已存在）")

    # 新增線索
    clues_added = 0
    clues_skipped = 0
    if clues:
        project = pm.load_project(project_name)
        existing = project.get("clues", {})
        clues_skipped = sum(1 for name in clues if name in existing)
        clues_added = pm.add_clues_batch(project_name, clues)
        print(f"線索: 新增 {clues_added} 個，跳過 {clues_skipped} 個（已存在）")

    # 資料驗證
    result = validate_project(project_name, projects_root=str(pm.projects_root))
    if result.valid:
        print("✅ 資料驗證透過")
    else:
        print("⚠️ 資料驗證發現問題:")
        for error in result.errors:
            print(f"  錯誤: {error}")
        for warning in result.warnings:
            print(f"  警告: {warning}")
        sys.exit(1)

    # 彙總
    total_added = chars_added + clues_added
    if total_added > 0:
        print(f"\n✅ 完成: 共新增 {total_added} 條資料")
    else:
        print("\nℹ️ 所有資料已存在，無新增")


if __name__ == "__main__":
    main()
