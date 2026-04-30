# ArcReel 360

> 這是 ArcReel 的繁體中文 fork。
> 
> 本倉庫以繁體中文作為主要文件語言與產品呈現方向，面向台灣與所有偏好繁體中文介面的使用者、部署者與二次開發者。

ArcReel 360 是基於原始 ArcReel 專案延伸維護的繁體中文版本，聚焦在二開可用性、多 provider assistant runtime，以及更適合自行部署與持續迭代的文件體驗。

新倉庫網址：<https://github.com/CreateIntelligens/arcreel360>

## 先說結論

如果你是因為搜尋 ArcReel 才來到這裡，最重要的差異可以先看這三點：

- 這不是 upstream 原版，而是以可維護 fork 為前提持續演進的版本。
- 這是繁體中文版本，README、changelog 與產品顯示文案都會優先朝繁體中文整理。
- 這個 fork 不把 assistant runtime 綁死在單一 provider 上，Gemini-only 與 OpenAI-only 部署也能走得通。

## 致謝

本專案建立於原始 ArcReel 專案的基礎之上。

- 原始專案：<https://github.com/ArcReel/ArcReel>
- 感謝原作者與原專案貢獻者，先把「小說到短影片」這條工作流做成可以實際運作的開源系統。

ArcReel 360 並不是否定原作，而是站在原作者已經打好的基礎上，繼續往「更容易二開、更少被單一 provider 綁死」的方向推進。

## 我們這個版本是什麼

ArcReel 360 仍然是一個 AI 影片生成工作台，核心目標沒有變：

1. 把小說或故事文本整理成可執行的劇本／分鏡資料。
2. 生成角色、線索、分鏡圖與影片片段。
3. 管理專案狀態、素材版本、費用與任務進度。
4. 透過內建 assistant 幫你在專案內推進工作，而不是只做聊天。

但和上游版本相比，這個 fork 更重視以下幾件事：

- assistant 不再預設只能綁 Anthropic / Claude。
- Gemini-only 與 OpenAI-only 部署可以真正把 assistant 開起來。
- 前端會依 provider 能力降級，不再假設所有 runtime 都有 Claude full capability。
- 文件與產品呈現以繁體中文為主，並明確說明 fork 與 upstream 的差異。

## 語系定位

ArcReel 360 的語系策略很直接：

- 主要對外文件以繁體中文撰寫。
- 產品中的使用者可見文案會持續往繁體中文收斂。
- changelog 會把「這是繁體中文 fork」當成長期維護定位的一部分，而不是一次性註記。

如果你想找的是原始 ArcReel 的簡體中文版本，請直接參考 upstream：<https://github.com/ArcReel/ArcReel>

## 與原作者版本的主要差異

下表是目前 ArcReel 360 與原作者版本最重要的差異。

| 項目 | 原作者版本 | ArcReel 360 |
| --- | --- | --- |
| Assistant runtime | 實際上綁定 Claude Agent SDK | 抽象成多 provider runtime |
| 可用 assistant provider | Claude full | Claude full、Gemini Lite、OpenAI Lite |
| 設定語意 | 缺少 Anthropic 常被視為全域未完成 | 改成目前 assistant provider 的 requirement |
| 同步 chat / session API | 隱含 Claude runtime | 回應會帶 provider 與 capability 資訊 |
| 前端 assistant 面板 | 預設所有 provider 都有完整能力 | 依 capability matrix 隱藏或禁用不支援功能 |
| Gemini-only / OpenAI-only 部署 | 很容易被 assistant 配置卡住 | 可透過 assistant provider 正常啟用 lite assistant |
| 文件與介面語系方向 | 簡體中文為主 | 繁體中文為主，並持續推進產品顯示文案繁體化 |
| 部署可維護性 | 以原始發布節奏為主 | 額外補回缺失 migration，確保目前 fork 可重新打包與啟動 |

### Assistant 能力差異

目前這個 fork 對 assistant runtime 採三層理解：

- `full`：完整 Claude runtime，保留原本較強的自治能力。
- `lite`：Gemini / OpenAI 可用的專案內 copilot 形態，支援基礎對話、串流與圖片輸入，但不追求 Claude parity。
- `workflow-grade`：這是後續路線，不等於複製 Claude SDK，而是把 ArcReel 真正需要的專案狀態判讀、階段推進與受限任務執行抽象出來。

簡單講：原作者版本的問題不是「模型預設值是 Claude」，而是「整條 assistant runtime 協定就是 Claude」。

ArcReel 360 做的事情，就是先把這個綁定拆開。

## 目前 fork 已完成的重點改動

### 1. 多 provider assistant runtime

- 新增 provider 抽象層，讓 assistant service 不再直接綁死在 Claude session manager 上。
- 保留 Claude 作為 `full` provider。
- 新增 Gemini Lite provider。
- 新增 OpenAI Lite provider。
- session / snapshot / status / 同步 chat API 會回傳 provider 與 capabilities。

### 2. 設定頁與前端降級

- 系統設定頁可直接選擇 assistant provider。
- Anthropic 不再是全域硬性必填，而是 Claude provider 的必要條件。
- Gemini Lite / OpenAI Lite 會在 UI 上顯示自身限制。
- assistant 面板會依 capability matrix 降級，例如 lite provider 不再假裝支援 resume 舊會話或 Claude-only 高階能力。

### 3. 部署與啟動修補

- 補回目前 fork 缺失的 Alembic migration 檔案，避免舊資料庫狀態升級到新容器時直接爆掉。
- 補上多 provider runtime 與既有 app startup 之間的相容介面，避免容器啟動時因 `start_patrol()` 缺失而重啟循環。

### 4. 文件與維護方向

- README 改寫為繁體中文 fork 版。
- 新增 changelog，追蹤本 fork 相對 upstream 的變更脈絡。
- 後續文件會優先以「如何二開、如何自部署、如何理解 provider 差異」為中心，而不是只描述原始設計。

## 功能概覽

ArcReel 360 目前仍保留 ArcReel 的主要工作流能力：

- 小說或故事內容整理
- 劇本／分鏡生成
- 角色圖與線索圖生成
- 分鏡圖片生成
- 影片片段生成
- 專案版控與版本回溯
- 成本追蹤與預估
- 剪映草稿匯出
- 專案內 assistant 協作

## 快速開始

### Docker 部署

```bash
git clone https://github.com/CreateIntelligens/arcreel360.git
cd arcreel360/deploy
cp .env.example .env
docker compose up -d
```

預設啟動後可透過以下位址進入：

- <http://localhost:1241>

### 首次設定建議順序

1. 先登入系統管理介面。
2. 到設定頁決定你要用哪個 assistant provider。
3. 再補對應 provider 所需的金鑰或後端設定。
4. 接著配置圖片、影片、文字生成供應商。

### Assistant provider 建議

如果你是以下情境，建議這樣選：

- 你本來就依賴 Claude Agent SDK：選 `claude`
- 你只有 Gemini key：選 `gemini-lite`
- 你主要走 OpenAI / ChatGPT 相容路線：選 `openai-lite`

## Assistant provider 說明

### Claude Full

適用於你想保留原始 Claude runtime 工作方式的情境。

特性：

- 支援完整 session resume
- 支援較高階的 agent runtime 能力
- 維持與既有 Claude Agent SDK 流程的相容性

### Gemini Lite

適用於你沒有 Anthropic、但已經有 Gemini provider 與模型配置的情境。

特性：

- 支援專案內基礎對話
- 支援圖片輸入
- 支援串流輸出
- 不追求 Claude full runtime parity

限制：

- 不支援 Claude 等級的 resume 舊會話語意
- 不支援 subagent / permission hooks

### OpenAI Lite

適用於你要把 assistant 跑在 OpenAI / ChatGPT 相容後端上的情境。

特性與限制大致和 Gemini Lite 相同，只是底層後端改成 OpenAI 相容路線。

## 技術架構

目前專案仍是三層結構：

```text
frontend/   React SPA
server/     FastAPI + assistant / SSE / routers
lib/        核心工作流、provider backends、queue、project manager
```

assistant 相關的核心變化在於：

```text
Frontend Assistant Panel
        ↓
AssistantService
        ↓
AssistantRuntimeProvider
   ├─ ClaudeRuntimeProvider
   ├─ GeminiLiteProvider
   └─ OpenAILiteProvider
```

這表示從現在開始，assistant 的可替換點不再只是模型名稱，而是整個 runtime provider。

## 供應商支援

本專案仍保留多供應商圖片、影片、文字生成能力，包含但不限於：

- Gemini
- 火山方舟
- Grok
- OpenAI
- 自訂 OpenAI 相容供應商
- 自訂 Google 相容供應商

不同供應商可配置在：

- 全域預設
- 專案層級
- assistant provider 層級

assistant provider 與媒體生成 provider 是兩個不同面向，不要混在一起理解。

## 這個 fork 適合誰

如果你符合下面任一種情況，ArcReel 360 比較適合你：

- 你要拿 ArcReel 來二開，而不是只想照 upstream 原樣使用。
- 你不想被 Anthropic 單一綁定。
- 你只有 Gemini key 或 OpenAI key，但還是想開 assistant。
- 你希望文件能直接說清楚 fork 的設計差異與限制。

## 與 upstream 的協作態度

這個 fork 會維持對原作者的尊重。

我們的做法是：

- 明確標示這是 fork，不裝成原作本體。
- 感謝原作者打下的工作流基礎。
- 在 README 與 changelog 中清楚區分 upstream 與 fork 的差異。
- 針對二開需求持續補強，而不是把所有變更都包裝成「原版就該這樣」。

## 文件與變更紀錄

- Fork 變更紀錄請看 [CHANGELOG.md](CHANGELOG.md)
- 上游原始設計與既有文件仍可參考 [docs/getting-started.md](docs/getting-started.md)
- 本 fork 的多 provider assistant 變更規格可參考 [openspec/changes/multi-provider-assistant-runtime](openspec/changes/multi-provider-assistant-runtime)

## 授權

本專案沿用原始專案授權，詳見 [LICENSE](LICENSE)。
