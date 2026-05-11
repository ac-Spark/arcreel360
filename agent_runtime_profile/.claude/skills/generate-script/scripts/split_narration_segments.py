#!/usr/bin/env python3
"""
split_narration_segments.py - 使用 LLM 將小說原文拆分為說書模式片段

用法:
    python split_narration_segments.py --episode <N>
    python split_narration_segments.py --episode <N> --source <file>
    python split_narration_segments.py --episode <N> --dry-run
"""

import argparse
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[5]  # agent_runtime_profile/.claude/skills/generate-script/scripts -> repo root
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


def main():
    parser = argparse.ArgumentParser(
        description="使用 LLM 將說書模式小說拆分為片段表",
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
        help="指定小說原始檔路徑（預設讀 source/episode_{N}.txt 或整個 source/ 目錄）",
    )
    parser.add_argument("--dry-run", action="store_true", help="僅顯示 Prompt，不實際呼叫 API")

    args = parser.parse_args()

    pm, project_name = ProjectManager.from_cwd()
    project_path = pm.get_project_path(project_name)
    project = pm.load_project(project_name)

    # 讀取小說原文
    if args.source:
        source_path = (project_path / args.source).resolve()
        if not source_path.is_relative_to(project_path.resolve()):
            print(f"❌ 路徑超出專案目錄: {source_path}")
            sys.exit(1)
        if not source_path.exists():
            print(f"❌ 未找到原始檔: {source_path}")
            sys.exit(1)
        novel_text = source_path.read_text(encoding="utf-8")
    else:
        # 優先用 episode_{N}.txt，找不到再讀整個 source/
        candidate = project_path / "source" / f"episode_{args.episode}.txt"
        if candidate.exists():
            novel_text = candidate.read_text(encoding="utf-8")
        else:
            source_dir = project_path / "source"
            if not source_dir.exists() or not any(source_dir.iterdir()):
                print(f"❌ source/ 目錄為空或不存在: {source_dir}")
                sys.exit(1)
            texts = []
            for f in sorted(source_dir.iterdir()):
                if f.suffix in (".txt", ".md", ".text"):
                    texts.append(f.read_text(encoding="utf-8"))
            novel_text = "\n\n".join(texts)

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
