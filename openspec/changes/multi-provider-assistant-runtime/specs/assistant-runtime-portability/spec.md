## ADDED Requirements

### Requirement: Assistant runtime SHALL 支持多 provider 抽象

系统 SHALL 通过统一的 assistant runtime provider 接口承载不同的助手实现，而不是将会话、流式输出和状态机直接绑定到单一供应商 SDK。

#### Scenario: 注册 Claude full provider
- **WHEN** 系统启动并加载 Claude runtime
- **THEN** Claude provider SHALL 通过统一 provider 接口注册，并声明其 provider 标识、tier 和 capability 集合

#### Scenario: 注册 Gemini lite provider
- **WHEN** 系统启动并加载 Gemini runtime
- **THEN** Gemini provider SHALL 通过同一接口注册，而不要求模拟 Claude SDK 专有的 hook、subagent 或 transcript 协议

#### Scenario: 注册 OpenAI lite provider
- **WHEN** 系统启动并加载 OpenAI/ChatGPT runtime
- **THEN** OpenAI provider SHALL 通过同一接口注册，而不要求模拟 Claude SDK 专有的 hook、subagent 或 transcript 协议

### Requirement: Assistant runtime SHALL 暴露 capability matrix

系统 SHALL 为当前 assistant provider 暴露结构化 capability matrix，用于 API、前端和业务逻辑进行能力协商与降级。

#### Scenario: Claude full provider
- **WHEN** 当前 active provider 为 Claude
- **THEN** capability matrix SHALL 标记 `supports_subagents = true`、`supports_resume = true`，并暴露其他已支持能力

#### Scenario: Gemini lite provider
- **WHEN** 当前 active provider 为 Gemini-lite
- **THEN** capability matrix SHALL 至少标记 `supports_streaming = true`、`supports_images = true`，并将不支持的高阶能力明确标记为 `false`

#### Scenario: OpenAI lite provider
- **WHEN** 当前 active provider 为 OpenAI-lite
- **THEN** capability matrix SHALL 至少标记 `supports_streaming = true`，并将不支持的高阶能力明确标记为 `false`

### Requirement: Assistant runtime SHALL 区分 lite、workflow-grade 与 full 层级

系统 SHALL 将 provider 能力层级分为 `lite`、`workflow-grade` 与 `full`，以反映 ArcReel 的真实产品需求，而不是仅用单一 full 概念描述所有高阶能力。

#### Scenario: lite provider
- **WHEN** provider 只支持项目内问答、提示辅助与有限工具调用
- **THEN** 系统 SHALL 将其标记为 `tier = lite`

#### Scenario: workflow-grade provider
- **WHEN** provider 支持项目状态检测、分阶段推进与受限子任务调度，但不支持 Claude 等价的完整 runtime 语义
- **THEN** 系统 SHALL 将其标记为 `tier = workflow-grade`

### Requirement: 不支持的能力 SHALL 以结构化方式降级

当调用方向当前 provider 请求其不支持的能力时，系统 SHALL 返回结构化的 `unsupported_capability` 语义，而不是假装成功或暴露底层 provider 异常。

#### Scenario: Gemini provider 收到 subagent 请求
- **WHEN** 当前 active provider 为 Gemini-lite，且请求需要 subagent 调度
- **THEN** 系统 SHALL 返回结构化错误，指出 `subagents` 能力当前 provider 不支持

#### Scenario: OpenAI provider 收到 workflow-grade 之外的 full 请求
- **WHEN** 当前 active provider 为 OpenAI-lite，且客户端请求其不支持的 full runtime 能力
- **THEN** 系统 SHALL 返回结构化错误，指出对应能力当前 provider 不支持

#### Scenario: Gemini provider 收到 resume 请求
- **WHEN** 当前 active provider 为 Gemini-lite，且客户端请求恢复不支持的历史会话
- **THEN** 系统 SHALL 返回结构化错误，指出 `resume` 能力当前 provider 不支持