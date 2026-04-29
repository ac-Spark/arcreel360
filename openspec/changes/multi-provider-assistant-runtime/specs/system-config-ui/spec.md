## MODIFIED Requirements

### Requirement: 必填配置缺失时全局入口警告

系统 SHALL 仅将当前激活 assistant provider 所需的凭证视为助手能力的必填配置，不得将 Anthropic API Key 无条件视为全局必填项。

#### Scenario: Gemini-only 部署且 assistant provider 为 Gemini-lite
- **WHEN** 系统的生成链路凭证已完整，active assistant provider 为 Gemini-lite，且未配置 Anthropic API Key
- **THEN** 设置入口与设置页 SHALL 不因缺少 Anthropic API Key 而标记为全局配置未完成

#### Scenario: OpenAI-only 部署且 assistant provider 为 OpenAI-lite
- **WHEN** 系统的生成链路凭证已完整，active assistant provider 为 OpenAI-lite，且未配置 Anthropic API Key
- **THEN** 设置入口与设置页 SHALL 不因缺少 Anthropic API Key 而标记为全局配置未完成

#### Scenario: assistant provider 为 Claude 且未配置 Anthropic
- **WHEN** active assistant provider 为 Claude，且 `anthropic_api_key.is_set === false`
- **THEN** 设置页 SHALL 将其显示为 Claude assistant 的 provider-specific 缺失项，并引导用户补全 Claude 所需配置

### Requirement: 设置页 SHALL 显示 assistant provider 状态

设置页 SHALL 展示当前 active assistant provider、其 capability tier 以及其所需配置状态，帮助用户理解为什么某些 assistant 功能可用或不可用。

#### Scenario: 当前 provider 为 Gemini-lite
- **WHEN** 用户进入设置页的助手配置区域
- **THEN** 页面 SHALL 显示 Gemini-lite 为当前 provider，并说明其为 lite tier、支持项与限制项

#### Scenario: 当前 provider 为 OpenAI-lite
- **WHEN** 用户进入设置页的助手配置区域
- **THEN** 页面 SHALL 显示 OpenAI-lite 为当前 provider，并说明其为 lite tier、支持项与限制项

#### Scenario: 当前 provider 缺少必需配置
- **WHEN** 当前 active assistant provider 缺少运行所需凭证
- **THEN** 页面 SHALL 显示该 provider 对应的缺失配置与影响范围，而不是使用泛化的系统级错误文案