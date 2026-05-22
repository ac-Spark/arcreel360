#!/usr/bin/env python3
"""
split_narration_segments.py - 使用 LLM 將小說原文拆分為說書模式片段

用法:
    python split_narration_segments.py --episode <N>
    python split_narration_segments.py --episode <N> --source <file>
    python split_narration_segments.py --episode <N> --dry-run
"""

import argparse
import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = (
    Path(__file__).resolve().parents[5]
)  # agent_runtime_profile/.claude/skills/generate-script/scripts -> repo root
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import asyncio

from lib.project_manager import ProjectManager
from lib.text_backends.base import TextGenerationRequest, TextTaskType
from lib.text_backends.factory import create_text_backend_for_task


def build_split_prompt(
    novel_text: str,
    project_overview: dict,
    style: str,
    characters: dict,
    clues: dict,
) -> str:
    """構建說書片段拆分的 Prompt"""

    def _format(items: dict) -> str:
        lines = []
        for name, data in items.items():
            desc = ""
            if isinstance(data, dict):
                desc = (data.get("description") or "").strip()
            if desc:
                lines.append(f"- **{name}**：{desc}")
            else:
                lines.append(f"- **{name}**")
        return "\n".join(lines) or "（暫無）"

    char_block = _format(characters)
    clue_block = _format(clues)

    return f"""你的任務是將中文小說原文按朗讀節奏拆分為適合短影片配音的片段，輸出 Markdown 表格。

## 核心原則

1. **保留原文**：不改編、不刪減、不新增小說原文內容；每個片段的「原文」欄位必須是小說中的連續一段文字。
2. **朗讀節奏**：每片段約 4 秒（約 20-24 個中文字），在自然斷句處拆分。
3. **片段拼接後等於原文**：把所有片段「原文」依序串起，應與輸入小說（去除前後空白）等價。

## 拆分規則

### 時長
- 預設 4 秒（約 20-24 個中文字）
- 長句（超過 24 字）可用 6 秒或 8 秒
- 保持語義完整性，不拆斷完整的語義單元

### 拆分點
- 優先在句號、問號、感嘆號、省略號等標點處拆分
- 段落結束處拆分
- 對話前後可拆分，但對話本體不要在中途拆斷

### 對話標記
- 識別包含角色對話的片段：含 `「」`、`""` 或「XXX說道」等敘述性引語
- 在「有對話」欄位標記「是」，否則標「否」

### 場景切換（segment_break）
- 在真正的場景切換點標記「是」：時間跳躍、空間轉換、視角切換、重大情節轉折
- 同一連續場景內標記「-」
- 不要濫用；多數片段應為「-」

## 專案資訊

<overview>
{project_overview.get("synopsis", "")}

題材類型：{project_overview.get("genre", "")}
核心主題：{project_overview.get("theme", "")}
世界觀設定：{project_overview.get("world_setting", "")}
</overview>

<style>
{style}
</style>

<characters>
{char_block}
</characters>

<clues>
{clue_block}
</clues>

## 小說原文

<novel>
{novel_text}
</novel>

## 輸出格式

僅輸出以下 Markdown，不要包含任何其他解釋文字：

```markdown
## 片段拆分結果

| 片段 | 原文 | 字數 | 時長 | 有對話 | segment_break |
|------|------|------|------|--------|---------------|
| G01 | …原文… | 22 | 4s | 否 | - |
| G02 | …原文… | 24 | 4s | 是 | - |
| G03 | …原文… | 6  | 4s | 否 | 是 |
```

規則：
- 片段編號從 G01 開始遞增（兩位數補零）
- 「原文」欄位若包含 `|` 字符，請以 `\\|` 跳脫
- 「字數」為原文中文字數（可粗略估計）
- 「時長」只能是 `4s`、`6s` 或 `8s`
- 「有對話」只能是 `是` 或 `否`
- 「segment_break」只能是 `是` 或 `-`
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


def _episode_index_and_total(project_path: Path, episode: int) -> tuple[int, int]:
    """從 project.json 算出 (該集在升序集列表中的 1-based 索引, 總集數)。

    project.json 不存在 / 無 episodes / 該集不在列表 → 退化為 (1, 1)，
    亦即把整本當單一一集，確保仍可拆段。
    """
    project_json = project_path / "project.json"
    if not project_json.exists():
        return (1, 1)
    try:
        data = json.loads(project_json.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return (1, 1)
    episodes = data.get("episodes") or []
    numbers = sorted(int(ep["episode"]) for ep in episodes if isinstance(ep, dict) and "episode" in ep)
    if not numbers or episode not in numbers:
        return (1, 1)
    return (numbers.index(episode) + 1, len(numbers))


def resolve_novel_text(project_path: Path, episode: int, source: str | None) -> str:
    """決定並讀取某集的小說原文。

    解析順序：
    1. 使用者指定 source → 讀該檔（覆寫自動均分）。
    2. source/episode_{episode}.txt 存在 → 讀它（進階使用者手動精切的產物）。
    3. 否則 → 讀 source/ 整本原文，按 project.json 的集數均分，取本集那一段。

    Raises:
        ValueError: 指定的 source 路徑超出專案目錄。
        FileNotFoundError: 指定的 source 檔不存在或路徑無效。
        SourceNotReadyError: 未指定 source 且 source/ 內無原文檔／整本內容為空／均分後該集為空。
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
        raise SourceNotReadyError("source/ 內沒有可用的小說原文。請先在資產面板上傳小說原文檔，再執行拆段。")

    from lib.episode_splitter import split_into_n_episodes

    index, total = _episode_index_and_total(project_path, episode)
    parts = split_into_n_episodes(whole, total)
    result = parts[index - 1]
    if not result.strip():
        raise SourceNotReadyError(
            f"均分原文後第 {episode} 集的內容為空。整本原文共計 {len(whole)} 字，無法均分成 {total} 集。請確認小說字數是否足夠或集數設定是否正確。"
        )
    return result


def main():
    parser = argparse.ArgumentParser(
        description="""使用 LLM 將小說原文拆分為說書模式片段。
預設會輸出 Markdown 片段表到 drafts/episode_{episode}/step1_segments.md。

使用範例:
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

    prompt = build_split_prompt(
        novel_text=novel_text,
        project_overview=project.get("overview", {}),
        style=project.get("style", ""),
        characters=project.get("characters", {}),
        clues=project.get("clues", {}),
    )

    if args.dry_run:
        print("=" * 60)
        print("DRY RUN - 以下是將傳送給 LLM 的 Prompt:")
        print("=" * 60)
        print(prompt)
        print("=" * 60)
        print(f"\nPrompt 長度: {len(prompt)} 字元")
        return

    async def _run():
        backend = await create_text_backend_for_task(TextTaskType.SCRIPT)
        print(f"正在使用 {backend.model} 拆分片段...")
        result = await backend.generate(TextGenerationRequest(prompt=prompt))
        return result.text

    response = asyncio.run(_run())

    drafts_dir = project_path / "drafts" / f"episode_{args.episode}"
    drafts_dir.mkdir(parents=True, exist_ok=True)
    step1_path = drafts_dir / "step1_segments.md"
    step1_path.write_text(response.strip(), encoding="utf-8")
    print(f"✅ 片段表已儲存: {step1_path}")

    # 簡要統計：計算 | G... | 開頭的資料行
    lines = [
        line
        for line in response.split("\n")
        if line.strip().startswith("|") and "片段" not in line and "---" not in line
    ]
    print(f"\n📊 生成統計: {len(lines)} 個片段")


if __name__ == "__main__":
    main()
