---
name: manage-project
description: 專案管理工具集。使用場景：(1) 分集切分——探測切分點並執行切分，(2) 批次新增角色/線索到 project.json。提供 peek（預覽）+ split（執行）的漸進式切分工作流，以及角色/線索批次寫入。
user-invocable: false
---

# 專案管理工具集

提供專案檔案管理的命令列工具，主要用於分集切分和角色/線索批次寫入。

## 工具一覽

| 指令碼 | 功能 | 呼叫者 |
|------|------|--------|
| `peek_split_point.py` | 探測目標字數附近的上下文和自然斷點 | 主 agent（階段 2） |
| `split_episode.py` | 執行分集切分，生成 episode_N.txt + _remaining.txt | 主 agent（階段 2） |
| `add_characters_clues.py` | 批次新增角色/線索到 project.json | subagent |

## 分集切分工作流

分集切分採用 **peek → 使用者確認 → split** 的漸進式流程，由主 agent 在 manga-workflow 階段 2 直接執行。

### Step 1: 探測切分點

```bash
python .claude/skills/manage-project/scripts/peek_split_point.py --source {原始檔} --target {目標字數}
```

**引數**：
- `--source`：原始檔路徑（`source/novel.txt` 或 `source/_remaining.txt`）
- `--target`：目標有效字數
- `--context`：上下文視窗大小（預設 200 字元）

**輸出**（JSON）：
- `total_chars`：總有效字數
- `target_offset`：目標字數對應的原文偏移
- `context_before` / `context_after`：切分點前後上下文
- `nearby_breakpoints`：附近自然斷點列表（按距離排序，最多 10 個）

### Step 2: 執行切分

```bash
# Dry run（僅預覽）
python .claude/skills/manage-project/scripts/split_episode.py --source {原始檔} --episode {N} --target {目標字數} --anchor "{錨點文字}" --dry-run

# 實際執行
python .claude/skills/manage-project/scripts/split_episode.py --source {原始檔} --episode {N} --target {目標字數} --anchor "{錨點文字}"
```

**引數**：
- `--source`：原始檔路徑
- `--episode`：集數編號
- `--target`：目標有效字數（與 peek 一致）
- `--anchor`：切分點的錨點文字（10-20 字元）
- `--context`：搜尋視窗大小（預設 500 字元）
- `--dry-run`：僅預覽，不寫檔案

**定位機制**：target 字數計算大致偏移 → 在 ±window 範圍內搜尋 anchor → 使用距離最近的匹配

**輸出檔案**：
- `source/episode_{N}.txt`：前半部分
- `source/_remaining.txt`：後半部分（下一集的原始檔）

### 分集切分（peek + split）

`peek_split_point` / `split_episode` / `preprocess_episode` 對 `gemini-full` / `openai-full` 是 functions；對 Claude 則是 `manage-project/scripts/peek_split_point.py` / `split_episode.py` 兩個 CLI 腳本（用法見上）。兩條路徑共用 `lib/episode_splitter.py` 的核心邏輯，行為應保持一致。

流程：
1. `peek_split_point(source="source/novel.txt", target_chars=3000)` → 查看目標位置前後文與 `nearby_breakpoints`
2. 從斷點前取 10~20 字作為 anchor → `split_episode(source="source/novel.txt", episode=1, target_chars=3000, anchor="...")`
3. `split_episode` 產生 `source/episode_1.txt` 與 `source/_remaining.txt`，並更新 `project.json`
4. 對 `source/_remaining.txt` 重複 peek + split，繼續切下一集
5. `preprocess_episode(episode=1)` 產生 `drafts/episode_1/step1_*.md`

失敗時 functions 一律回 `{"ok": false, "error": "...", "reason": "..."}`；CLI 腳本則把錯誤印到 stderr 並以非零結束碼退出。看到失敗不可回報完成，必須依錯誤訊息修正參數後重試。

## 角色/線索批次寫入

從專案目錄內執行，自動檢測專案名稱：

⚠️ 必須單行，JSON 使用緊湊格式，不可用 `\` 換行：

```bash
python .claude/skills/manage-project/scripts/add_characters_clues.py --characters '{"角色名": {"description": "...", "voice_style": "..."}}' --clues '{"線索名": {"type": "prop", "description": "...", "importance": "major"}}'
```

腳本行為：
- `--characters` / `--clues` 的值必須是合法 JSON 物件；解析失敗、傳了空物件、或寫入後驗證 project.json 發現缺漏，都會 **exit 1 並把錯誤印到 stderr**。
- 看到非零結束碼或 `❌` 開頭的訊息，代表**沒有成功寫入**，不可向使用者回報已完成——請依錯誤訊息修正參數（最常見：JSON 引號跳脫、誤用 `\` 換行）後重試。
- 成功時會印出「角色: 新增 N 個…」「✅ 完成」並結束碼 0。

## 字數統計規則

- 統計非空行的所有字元（包括標點）
- 空行（僅含空白字元的行）不計入
