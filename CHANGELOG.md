# Changelog

本檔記錄 ArcReel 360 相對原始 ArcReel 專案的重要差異與維護脈絡。

## 2026-04-29

### Fork 定位

- 建立 ArcReel 360 的 fork 敘事與繁體中文文件方向。
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
| 文件語系 | 簡體中文為主 | 繁體中文為主 |
| 二開定位 | 偏 upstream 原始產品敘事 | 偏 fork 維護與可二開性 |
