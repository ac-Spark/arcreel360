# Changelog

本檔記錄 ArcReel 360 相對原始 ArcReel 專案的重要差異與維護脈絡。

## 2026-04-30

### 繁體版本定位強化

- 在 README 首屏明確標示：ArcReel 360 是 ArcReel 的繁體中文 fork。
- 補上更直接的語系定位說明，讓外部讀者第一眼就知道這不是 upstream 的簡體中文倉庫。
- 將「繁體中文」從單純檔案描述，提升為 fork 的對外定位與維護承諾。

### 檔案與產品呈現方向

- README 新增更高可見度的繁體中文版本宣告與語系策略說明。
- 明確說明本 fork 的產品顯示文案將持續朝繁體中文收斂。
- 保持與 upstream 的區隔：原版仍可參考 upstream，本倉庫則明確面向繁體中文使用者與二開場景。

## 2026-04-29

### Fork 定位

- 建立 ArcReel 360 的 fork 敘事與繁體中文檔案方向。
- README 改為以 fork、二開、多 provider assistant 為核心，而不是延續 upstream 的單一路徑描述。
- 明確標示新倉庫網址：<https://github.com/CreateIntelligens/arcreel360>
- 明確致謝原作者與原始 ArcReel 專案：<https://github.com/ArcReel/ArcReel>

### Assistant Runtime

- 將 assistant runtime 從 Claude 專屬路徑抽象為多 provider runtime。
- 保留 Claude 作為 `full` provider。
- 新增 Gemini Lite provider。
- 新增 OpenAI Lite provider。
- session / snapshot / status / 同步 chat API 現在可暴露 provider 與 capability 資訊。

### Frontend 與配置語意

- 系統設定頁新增 assistant provider 選擇。
- 將 Anthropic 從全域硬性必填改為 Claude provider 的 provider-specific requirement。
- Gemini-only 與 OpenAI-only 場景不再因缺少 Anthropic 被誤判為設定未完成。
- assistant 面板改為依 capability matrix 隱藏或禁用不支援功能。

### 部署與穩定性

- 補回缺失的 Alembic migration，恢復部署資料庫的 revision 鏈。
- 修正多 provider runtime 與既有 app startup 的相容性，補回 `start_patrol()` 啟動路徑。
- 重新建置 Docker image 並完成容器替換，確認 `/health` 正常回應。

### 與原作者版本的摘要差異

| 面向 | 原作者版本 | ArcReel 360 |
| --- | --- | --- |
| Assistant 核心設計 | Claude runtime 為中心 | 多 provider runtime 為中心 |
| 可用 assistant | Claude | Claude、Gemini Lite、OpenAI Lite |
| 配置判定 | Anthropic 容易被視為全域必填 | 改為依目前 provider 判定 |
| 前端能力假設 | 預設 provider 能力完整一致 | 顯式 capability 降級 |
| 檔案語系 | 簡體中文為主 | 繁體中文為主 |
| 二開定位 | 偏 upstream 原始產品敘事 | 偏 fork 維護與可二開性 |
