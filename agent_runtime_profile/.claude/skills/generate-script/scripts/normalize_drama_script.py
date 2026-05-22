#!/usr/bin/env python3
"""
normalize_drama_script.py - 使用 Gemini Pro 生成規範化劇本

將 source/ 小說原文轉化為 Markdown 格式的規範化劇本（step1_normalized_script.md），
供 generate_script.py 消費。

用法:
    python normalize_drama_script.py --episode <N>
    python normalize_drama_script.py --episode <N> --source <file>
    python normalize_drama_script.py --episode <N> --dry-run
"""

import argparse
import re
import sys
from pathlib import Path

# 允許從倉庫任意工作目錄直接執行該指令碼
PROJECT_ROOT = (
    Path(__file__).resolve().parents[5]
)  # agent_runtime_profile/.claude/skills/generate-script/scripts -> repo root
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import asyncio

from lib.project_manager import ProjectManager
from lib.text_backends.base import TextGenerationRequest, TextTaskType
from lib.text_backends.factory import create_text_backend_for_task


def build_normalize_prompt(
    novel_text: str,
    project_overview: dict,
    style: str,
    characters: dict,
    clues: dict,
) -> str:
    """構建規範化劇本的 Prompt"""

    char_list = "\n".join(f"- {name}" for name in characters.keys()) or "（暫無）"
    clue_list = "\n".join(f"- {name}" for name in clues.keys()) or "（暫無）"

    return f"""你的任務是將小說原文改編為結構化的分鏡場景表（Markdown 格式），用於後續 AI 影片生成。

## 專案資訊

<overview>
{project_overview.get("synopsis", "")}

題材型別：{project_overview.get("genre", "")}
核心主題：{project_overview.get("theme", "")}
世界觀設定：{project_overview.get("world_setting", "")}
</overview>

<style>
{style}
</style>

<characters>
{char_list}
</characters>

<clues>
{clue_list}
</clues>

## 小說原文

<novel>
{novel_text}
</novel>

## 輸出要求

將小說改編為場景列表，使用 Markdown 表格格式：

| 場景 ID | 場景描述 | 時長 | 場景型別 | segment_break |
|---------|---------|------|---------|---------------|
| E{{N}}S01 | 詳細的場景描述... | 8 | 劇情 | 是 |
| E{{N}}S02 | 詳細的場景描述... | 8 | 對話 | 否 |

規則：
- 場景 ID 格式：E{{集數}}S{{兩位序號}}（如 E1S01, E1S02）
- 場景描述：改編後的劇本化描述，包含角色動作、對話、環境，適合視覺化呈現
- 時長：4、6 或 8 秒（預設 8 秒，簡單畫面可用 4 或 6 秒）
- 場景型別：劇情、動作、對話、過渡、空鏡
- segment_break：場景切換點標記"是"，同一連續場景標"否"
- 每個場景應為一個獨立的視覺畫面，可以在指定時長內完成
- 避免一個場景包含多個不同的動作或畫面切換

僅輸出 Markdown 表格，不要包含其他解釋文字。
"""


# 「尚未分集切分」專用退出碼：run_preprocess 依此把錯誤映射成 HTTP 400。
SOURCE_NOT_READY_EXIT_CODE = 3

# 視為小說原文的副檔名（單檔 fallback 用）。
_SOURCE_SUFFIXES = (".txt", ".md", ".text")


class SourceNotReadyError(FileNotFoundError):
    """缺少可用的小說原文，需使用者上傳或指定來源。

    繼承 FileNotFoundError 以沿用 resolve_novel_text 呼叫端既有的 except 分支；
    main() 會把它對應到 SOURCE_NOT_READY_EXIT_CODE 退出。
    """


def _episode_source_files(source_dir: Path) -> list[Path]:
    """列出 source/ 內可視為小說原文的檔案（排除分集切分產生的 _remaining.txt 與 episode_N.txt）。"""
    if not source_dir.is_dir():
        return []
    return sorted(
        f
        for f in source_dir.iterdir()
        if (
            f.is_file()
            and f.suffix.lower() in _SOURCE_SUFFIXES
            and f.name != "_remaining.txt"
            and not re.match(r"^episode_\d+\.(txt|md|text)$", f.name, re.IGNORECASE)
        )
    )


def _read_whole_source(source_dir: Path) -> str:
    """把 source/ 內所有原文檔按檔名排序串接成「整本原文」。"""
    files = _episode_source_files(source_dir)
    return "\n\n".join(f.read_text(encoding="utf-8") for f in files)


def resolve_novel_text(project_path: Path, episode: int, source: str | None) -> str:
    """決定並讀取某集的小說原文。

    解析順序：
    1. 使用者指定 source → 讀該檔。
    2. source/episode_{episode}.txt 存在 → 讀它（進階使用者手動精切的產物）。
    3. 否則 → 讀 source/ 整本原文（不均分，直接回傳整本）。

    Raises:
        ValueError: 指定的 source 路徑超出專案目錄。
        FileNotFoundError: 指定的 source 檔不存在或路徑無效。
        SourceNotReadyError: 未指定 source 且 source/ 內無原文檔／整本內容為空。
    """
    if source is not None:
        if not source.strip():
            raise FileNotFoundError("未指定原始檔路徑（指定了空路徑）")
        project_root = project_path.resolve()
        sources = [s.strip() for s in source.split(",") if s.strip()]
        if not sources:
            raise FileNotFoundError("未指定原始檔路徑（指定了空路徑）")
        texts = []
        for src in sources:
            source_path = (project_path / src).resolve()
            if not source_path.is_relative_to(project_root):
                raise ValueError(f"路徑超出專案目錄: {source_path}")
            if not source_path.exists() or source_path.is_dir():
                raise FileNotFoundError(f"未找到原始檔: {source_path}")
            texts.append(source_path.read_text(encoding="utf-8"))
        return "\n\n".join(texts)

    candidate = project_path / "source" / f"episode_{episode}.txt"
    if candidate.exists():
        return candidate.read_text(encoding="utf-8")

    whole = _read_whole_source(project_path / "source")
    if not whole.strip():
        raise SourceNotReadyError("source/ 內沒有可用的小說原文。請先在資產面板上傳小說原文檔，再執行規範化。")

    return whole


def main():
    parser = argparse.ArgumentParser(
        description="使用 Gemini Pro 生成規範化劇本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
    %(prog)s --episode 1
    %(prog)s --episode 1 --source source/episode_1.txt
    %(prog)s --episode 1 --dry-run
        """,
    )

    parser.add_argument("--episode", "-e", type=int, required=True, help="劇集編號")
    parser.add_argument(
        "--source",
        "-s",
        type=str,
        default=None,
        help="指定小說原始檔路徑，可用逗號分隔多檔（預設讀 source/episode_{N}.txt）",
    )
    parser.add_argument("--dry-run", action="store_true", help="僅顯示 Prompt，不實際呼叫 API")

    args = parser.parse_args()

    # 構建專案路徑
    pm, project_name = ProjectManager.from_cwd()
    project_path = pm.get_project_path(project_name)
    project = pm.load_project(project_name)

    # 讀取小說原文
    try:
        novel_text = resolve_novel_text(project_path, args.episode, args.source)
    except SourceNotReadyError as e:
        # 尚未分集切分：可由使用者修正，用專用退出碼讓上層映射成 HTTP 400。
        sys.stderr.write(f"SourceNotReadyError: {e}\n")
        print(f"❌ {e}")
        sys.exit(SOURCE_NOT_READY_EXIT_CODE)
    except (ValueError, FileNotFoundError) as e:
        print(f"❌ {e}")
        sys.exit(1)

    if not novel_text.strip():
        print("❌ 小說原文為空")
        sys.exit(1)

    # 構建 Prompt
    prompt = build_normalize_prompt(
        novel_text=novel_text,
        project_overview=project.get("overview", {}),
        style=project.get("style", ""),
        characters=project.get("characters", {}),
        clues=project.get("clues", {}),
    )

    if args.dry_run:
        print("=" * 60)
        print("DRY RUN - 以下是將傳送給 Gemini 的 Prompt:")
        print("=" * 60)
        print(prompt)
        print("=" * 60)
        print(f"\nPrompt 長度: {len(prompt)} 字元")
        return

    # 呼叫 TextBackend
    async def _run():
        backend = await create_text_backend_for_task(TextTaskType.SCRIPT)
        print(f"正在使用 {backend.model} 生成規範化劇本...")
        result = await backend.generate(TextGenerationRequest(prompt=prompt))
        return result.text

    response = asyncio.run(_run())

    # 儲存檔案
    drafts_dir = project_path / "drafts" / f"episode_{args.episode}"
    drafts_dir.mkdir(parents=True, exist_ok=True)

    step1_path = drafts_dir / "step1_normalized_script.md"
    step1_path.write_text(response.strip(), encoding="utf-8")
    print(f"✅ 規範化劇本已儲存: {step1_path}")

    # 簡要統計
    lines = [
        line
        for line in response.split("\n")
        if line.strip().startswith("|") and "場景 ID" not in line and "---" not in line
    ]
    scene_count = len(lines)
    print(f"\n📊 生成統計: {scene_count} 個場景")


if __name__ == "__main__":
    main()
