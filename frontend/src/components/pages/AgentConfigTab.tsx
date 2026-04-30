import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Eye, EyeOff, Loader2, SlidersHorizontal, Terminal, X } from "lucide-react";
import { useWarnUnsaved } from "@/hooks/useWarnUnsaved";
import ClaudeColor from "@lobehub/icons/es/Claude/components/Color";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useConfigStatusStore } from "@/stores/config-status-store";
import type { GetSystemConfigResponse, SystemConfigPatch } from "@/types";
import { TabSaveFooter } from "./TabSaveFooter";

// ---------------------------------------------------------------------------
// Draft types
// ---------------------------------------------------------------------------

interface AgentDraft {
  assistantProvider: string;
  anthropicKey: string;        // new API key input (empty = don't change)
  anthropicBaseUrl: string;    // in-place editing; empty = clear
  anthropicModel: string;      // in-place editing; empty = clear
  haikuModel: string;
  opusModel: string;
  sonnetModel: string;
  subagentModel: string;
  cleanupDelaySeconds: string;
  maxConcurrentSessions: string;
}

function buildDraft(data: GetSystemConfigResponse): AgentDraft {
  const s = data.settings;
  return {
    assistantProvider: s.assistant_provider ?? "claude",
    anthropicKey: "",
    anthropicBaseUrl: s.anthropic_base_url ?? "",
    anthropicModel: s.anthropic_model ?? "",
    haikuModel: s.anthropic_default_haiku_model ?? "",
    opusModel: s.anthropic_default_opus_model ?? "",
    sonnetModel: s.anthropic_default_sonnet_model ?? "",
    subagentModel: s.claude_code_subagent_model ?? "",
    cleanupDelaySeconds: String(s.agent_session_cleanup_delay_seconds ?? 300),
    maxConcurrentSessions: String(s.agent_max_concurrent_sessions ?? 5),
  };
}

function deepEqual(a: AgentDraft, b: AgentDraft): boolean {
  return (
    a.assistantProvider === b.assistantProvider &&
    a.anthropicKey === b.anthropicKey &&
    a.anthropicBaseUrl === b.anthropicBaseUrl &&
    a.anthropicModel === b.anthropicModel &&
    a.haikuModel === b.haikuModel &&
    a.opusModel === b.opusModel &&
    a.sonnetModel === b.sonnetModel &&
    a.subagentModel === b.subagentModel &&
    a.cleanupDelaySeconds === b.cleanupDelaySeconds &&
    a.maxConcurrentSessions === b.maxConcurrentSessions
  );
}

function buildPatch(draft: AgentDraft, saved: AgentDraft): SystemConfigPatch {
  const patch: SystemConfigPatch = {};
  if (draft.assistantProvider !== saved.assistantProvider)
    patch.assistant_provider = draft.assistantProvider;
  if (draft.anthropicKey.trim()) patch.anthropic_api_key = draft.anthropicKey.trim();
  if (draft.anthropicBaseUrl !== saved.anthropicBaseUrl)
    patch.anthropic_base_url = draft.anthropicBaseUrl || "";
  if (draft.anthropicModel !== saved.anthropicModel)
    patch.anthropic_model = draft.anthropicModel || "";
  if (draft.haikuModel !== saved.haikuModel)
    patch.anthropic_default_haiku_model = draft.haikuModel || "";
  if (draft.opusModel !== saved.opusModel)
    patch.anthropic_default_opus_model = draft.opusModel || "";
  if (draft.sonnetModel !== saved.sonnetModel)
    patch.anthropic_default_sonnet_model = draft.sonnetModel || "";
  if (draft.subagentModel !== saved.subagentModel)
    patch.claude_code_subagent_model = draft.subagentModel || "";
  if (draft.cleanupDelaySeconds !== saved.cleanupDelaySeconds)
    patch.agent_session_cleanup_delay_seconds = Number(draft.cleanupDelaySeconds) || 300;
  if (draft.maxConcurrentSessions !== saved.maxConcurrentSessions)
    patch.agent_max_concurrent_sessions = Number(draft.maxConcurrentSessions) || 5;
  return patch;
}

// ---------------------------------------------------------------------------
// Shared style constants
// ---------------------------------------------------------------------------

const cardClassName = "workbench-panel rounded-[1.2rem] p-5";
const inputClassName =
  "workbench-input w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none";
const smallBtnClassName =
  "rounded p-1 text-[color:var(--wb-text-dim)] hover:text-[color:var(--wb-text-secondary)] focus-visible:outline-none";

// Model routing config — static, hoisted to module level to avoid re-creation on each render
const MODEL_ROUTING_FIELDS = [
  {
    key: "haikuModel" as const,
    label: "Haiku 模型",
    envVar: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    hint: "輕量任務（分類、提取、簡單問答）",
    patchKey: "anthropic_default_haiku_model" as const,
  },
  {
    key: "sonnetModel" as const,
    label: "Sonnet 模型",
    envVar: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    hint: "均衡任务（写作、编排、多步推理）",
    patchKey: "anthropic_default_sonnet_model" as const,
  },
  {
    key: "opusModel" as const,
    label: "Opus 模型",
    envVar: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    hint: "複雜任務（長文創作、深度分析）",
    patchKey: "anthropic_default_opus_model" as const,
  },
  {
    key: "subagentModel" as const,
    label: "子 Agent 模型",
    envVar: "CLAUDE_CODE_SUBAGENT_MODEL",
    hint: "Subagent 平行執行時使用的模型",
    patchKey: "claude_code_subagent_model" as const,
  },
] as const;

// Small inline clear button shown next to "当前：" when a value is set
const inlineClearClassName =
  "ml-1.5 inline-flex items-center rounded p-0.5 text-[color:var(--wb-text-dim)] transition-colors hover:text-[color:var(--wb-danger)] disabled:cursor-not-allowed disabled:opacity-50";

const ASSISTANT_PROVIDER_META: Record<string, { label: string; tier: string; description: string; requirement: string }> = {
  claude: {
    label: "Claude Full",
    tier: "full",
    description: "保留現有 Claude Agent SDK 執行階段，支援更完整的會話與自治能力。",
    requirement: "需要設定 Anthropic API Key。",
  },
  "gemini-lite": {
    label: "Gemini Lite",
    tier: "lite",
    description: "使用 Gemini 文字／多模態後端提供專案內對話與輔助創作能力。",
    requirement: "需要設定可用的 Gemini 文字供應商。",
  },
  "openai-lite": {
    label: "OpenAI / ChatGPT Lite",
    tier: "lite",
    description: "使用 OpenAI 相容文字後端提供專案內對話與輔助創作能力。",
    requirement: "需要設定可用的 OpenAI 文字供應商。",
  },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-base font-semibold text-[color:var(--wb-text-primary)]">{title}</h3>
      <p className="mt-1 text-sm leading-6 text-[color:var(--wb-text-muted)]">{description}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AgentConfigTabProps {
  visible: boolean;
}

export function AgentConfigTab({ visible }: AgentConfigTabProps) {
  const [remoteData, setRemoteData] = useState<GetSystemConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentDraft>({
    assistantProvider: "claude",
    anthropicKey: "",
    anthropicBaseUrl: "",
    anthropicModel: "",
    haikuModel: "",
    opusModel: "",
    sonnetModel: "",
    subagentModel: "",
    cleanupDelaySeconds: "300",
    maxConcurrentSessions: "5",
  });
  const savedRef = useRef<AgentDraft>({
    assistantProvider: "claude",
    anthropicKey: "",
    anthropicBaseUrl: "",
    anthropicModel: "",
    haikuModel: "",
    opusModel: "",
    sonnetModel: "",
    subagentModel: "",
    cleanupDelaySeconds: "300",
    maxConcurrentSessions: "5",
  });
  const [saving, setSaving] = useState(false);
  const [clearingField, setClearingField] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [modelRoutingExpanded, setModelRoutingExpanded] = useState(false);

  // Load config on mount
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await API.getSystemConfig();
      setRemoteData(res);
      const d = buildDraft(res);
      savedRef.current = d;
      setDraft(d);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const isDirty = !deepEqual(draft, savedRef.current);
  useWarnUnsaved(isDirty);

  const updateDraft = useCallback(
    <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => {
      setDraft((prev) => ({ ...prev, [key]: value }));
      setSaveError(null);
    },
    [],
  );

  const handleSave = useCallback(async () => {
    const patch = buildPatch(draft, savedRef.current);
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await API.updateSystemConfig(patch);
      setRemoteData(res);
      const newDraft = buildDraft(res);
      savedRef.current = newDraft;
      setDraft(newDraft);
      useConfigStatusStore.getState().refresh();
      useAppStore.getState().pushToast("ArcReel 智能體設定已儲存", "success");
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const handleReset = useCallback(() => {
    setDraft(savedRef.current);
    setSaveError(null);
  }, []);

  // Clear a single field immediately via PATCH
  const handleClearField = useCallback(
    async (fieldId: string, patch: SystemConfigPatch, label: string) => {
      setClearingField(fieldId);
      try {
        const res = await API.updateSystemConfig(patch);
        setRemoteData(res);
        const nextSavedDraft = buildDraft(res);
        savedRef.current = nextSavedDraft;
        setDraft(nextSavedDraft);
        useConfigStatusStore.getState().refresh();
        useAppStore.getState().pushToast(`${label} 已清除`, "success");
      } catch (err) {
        useAppStore.getState().pushToast(`清除失敗：${(err as Error).message}`, "error");
      } finally {
        setClearingField(null);
      }
    },
    [],
  );

  const isBusy = saving || clearingField !== null;
  const providerMeta = ASSISTANT_PROVIDER_META[draft.assistantProvider] ?? ASSISTANT_PROVIDER_META.claude;

  // Loading / error states
  if (loadError) {
    return (
      <div className={visible ? "px-6 py-8" : "hidden"}>
        <div className="text-sm text-[color:var(--wb-danger)]">載入失敗：{loadError}</div>
        <button
          type="button"
          onClick={() => void load()}
          className="workbench-button-secondary mt-3 inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm"
        >
          <Loader2 className="h-4 w-4" />
          重試
        </button>
      </div>
    );
  }

  if (!remoteData) {
    return (
      <div className={visible ? "flex items-center gap-2 px-6 py-8 text-[color:var(--wb-text-muted)]" : "hidden"}>
        <Loader2 className="h-4 w-4 animate-spin text-[color:var(--wb-accent)]" />
        載入中…
      </div>
    );
  }

  const settings = remoteData.settings;

  return (
    <div className={visible ? undefined : "hidden"}>
      <div className="space-y-8 px-6 pb-0 pt-6">
        {/* Page intro */}
        <div className="workbench-panel-strong rounded-[1.4rem] px-5 py-5">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-white/6 bg-black/12 p-3 shadow-inner shadow-white/5">
              <ClaudeColor size={24} />
            </div>
            <div>
              <div className="workbench-kicker text-[11px] font-semibold">助理執行階段</div>
              <h2 className="mt-1 text-lg font-semibold text-[color:var(--wb-text-primary)]">ArcReel 智能體</h2>
              <p className="text-sm text-[color:var(--wb-text-muted)]">
                透過可切換的執行階段供應商，驅動對話式 AI 助手與自動化工作流程
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-start gap-2 rounded-2xl border border-white/6 bg-black/12 px-4 py-3">
            <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--wb-accent-cyan)]" />
            <p className="text-xs leading-6 text-[color:var(--wb-text-muted)]">
              設定項相容於 Claude Code 的環境變數命名，也可搭配相容的 Coding Plan API 使用。
            </p>
          </div>
        </div>

        <div>
          <SectionHeading
            title="執行階段供應商"
            description="選擇目前智能體使用的執行階段供應商；不同供應商支援的能力層級不同。"
          />

          <div className={`${cardClassName} space-y-4`}>
            <div>
              <label htmlFor="assistant-provider" className="text-sm font-medium text-gray-100">
                目前供應商
              </label>
              <select
                id="assistant-provider"
                value={draft.assistantProvider}
                onChange={(e) => updateDraft("assistantProvider", e.target.value)}
                className={`${inputClassName} mt-2`}
                disabled={saving}
              >
                {(remoteData?.options.assistant_providers ?? ["claude", "gemini-lite", "openai-lite"]).map((providerId) => (
                  <option key={providerId} value={providerId}>
                    {(ASSISTANT_PROVIDER_META[providerId] ?? { label: providerId }).label}
                  </option>
                ))}
              </select>
            </div>

            <div className="rounded-2xl border border-white/6 bg-black/12 px-4 py-4 text-sm text-[color:var(--wb-text-secondary)]">
              <div className="flex items-center gap-2 text-[color:var(--wb-text-primary)]">
                <span className="font-medium">{providerMeta.label}</span>
                <span className="rounded-full border border-white/6 px-2 py-0.5 text-xs uppercase tracking-wide text-[color:var(--wb-text-muted)]">
                  {providerMeta.tier}
                </span>
              </div>
              <p className="mt-2 text-sm text-[color:var(--wb-text-secondary)]">{providerMeta.description}</p>
              <p className="mt-2 text-xs text-[color:var(--wb-text-muted)]">{providerMeta.requirement}</p>
            </div>
          </div>
        </div>

        {/* ----------------------------------------------------------------- */}
        {/* Section 1: API Key + Base URL */}
        {/* ----------------------------------------------------------------- */}
        <div>
          <SectionHeading
            title="API 憑證"
            description={
              draft.assistantProvider === "claude"
                ? "Anthropic API 金鑰是 Claude 供應商運作的必要條件"
                : "以下 Claude 設定只會在切回 Claude 供應商時生效"
            }
          />

          {/* API Key card */}
          <div className={`${cardClassName} space-y-4`}>
            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="agent-anthropic-key" className="text-sm font-medium text-gray-100">
                  API Key
                </label>
                {settings.anthropic_api_key.is_set && (
                  <div className="flex items-center text-xs text-gray-500">
                    <span className="truncate">
                      目前：{settings.anthropic_api_key.masked ?? "已設定"}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void handleClearField(
                          "anthropic_api_key",
                          { anthropic_api_key: "" },
                          "Anthropic API Key",
                        )
                      }
                      disabled={isBusy}
                      className={inlineClearClassName}
                      aria-label="清除已儲存的 Anthropic API Key"
                    >
                      {clearingField === "anthropic_api_key" ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <X className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                )}
              </div>
              <p className="mt-0.5 text-xs text-gray-500">
                对应环境变量 ANTHROPIC_API_KEY
              </p>
              <div className="relative mt-2">
                <input
                  id="agent-anthropic-key"
                  type={showKey ? "text" : "password"}
                  value={draft.anthropicKey}
                  onChange={(e) => updateDraft("anthropicKey", e.target.value)}
                  placeholder="sk-ant-…"
                  className={`${inputClassName} pr-10`}
                  autoComplete="off"
                  spellCheck={false}
                  name="anthropic_api_key"
                  disabled={saving}
                />
                {draft.anthropicKey && (
                  <button
                    type="button"
                    onClick={() => updateDraft("anthropicKey", "")}
                    className={`absolute right-8 top-1/2 -translate-y-1/2 ${smallBtnClassName}`}
                    aria-label="清除輸入"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 ${smallBtnClassName}`}
                  aria-label={showKey ? "隱藏金鑰" : "顯示金鑰"}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Base URL */}
            <div className="border-t border-gray-800 pt-4">
              <div className="flex items-center justify-between">
                <label htmlFor="agent-base-url" className="text-sm font-medium text-gray-100">
                  Base URL
                </label>
                {settings.anthropic_base_url && (
                  <button
                    type="button"
                    onClick={() =>
                      void handleClearField(
                        "anthropic_base_url",
                        { anthropic_base_url: "" },
                        "Anthropic Base URL",
                      )
                    }
                    disabled={isBusy}
                    className="inline-flex items-center gap-1 rounded text-xs text-gray-600 transition-colors hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-indigo-500/60 focus-visible:outline-none"
                    aria-label="清除已儲存的 Anthropic Base URL"
                  >
                    {clearingField === "anthropic_base_url" ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <X className="h-3 w-3" />
                    )}
                    清除已儲存
                  </button>
                )}
              </div>
              <p className="mt-0.5 text-xs text-gray-500">
                對應 ANTHROPIC_BASE_URL，留空時使用官方預設位址
              </p>
              <div className="relative mt-2">
                <input
                  id="agent-base-url"
                  value={draft.anthropicBaseUrl}
                  onChange={(e) => updateDraft("anthropicBaseUrl", e.target.value)}
                  placeholder="https://anthropic-proxy.example.com"
                  className={`${inputClassName}${draft.anthropicBaseUrl ? " pr-8" : ""}`}
                  autoComplete="off"
                  spellCheck={false}
                  name="anthropic_base_url"
                  disabled={saving}
                />
                {draft.anthropicBaseUrl && (
                  <button
                    type="button"
                    onClick={() => updateDraft("anthropicBaseUrl", "")}
                    className={`absolute right-2 top-1/2 -translate-y-1/2 ${smallBtnClassName}`}
                    aria-label="清除 Base URL 輸入"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ----------------------------------------------------------------- */}
        {/* Section 2: Model Configuration */}
        {/* ----------------------------------------------------------------- */}
        <div>
          <SectionHeading
            title="模型設定"
            description="指定智能體使用的 Claude 模型。留空時會使用 Claude Agent SDK 的預設值。"
          />

          <div className={cardClassName}>
            <div className="flex items-center justify-between">
              <label htmlFor="agent-model" className="text-sm font-medium text-gray-100">
                預設模型
              </label>
              {settings.anthropic_model && (
                <button
                  type="button"
                  onClick={() =>
                    void handleClearField(
                      "anthropic_model",
                      { anthropic_model: "" },
                      "ANTHROPIC_MODEL",
                    )
                  }
                  disabled={isBusy}
                  className="inline-flex items-center gap-1 rounded text-xs text-gray-600 transition-colors hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-indigo-500/60 focus-visible:outline-none"
                  aria-label="清除已儲存的模型設定"
                >
                  {clearingField === "anthropic_model" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <X className="h-3 w-3" />
                  )}
                  清除已儲存
                </button>
              )}
            </div>
            <p className="mt-0.5 text-xs text-gray-500">
              對應 ANTHROPIC_MODEL，用於覆寫預設模型
            </p>
            <div className="relative mt-2">
              <input
                id="agent-model"
                value={draft.anthropicModel}
                onChange={(e) => updateDraft("anthropicModel", e.target.value)}
                placeholder="ANTHROPIC_MODEL"
                className={`${inputClassName}${draft.anthropicModel ? " pr-8" : ""}`}
                autoComplete="off"
                spellCheck={false}
                name="anthropic_model"
                disabled={saving}
              />
              {draft.anthropicModel && (
                <button
                  type="button"
                  onClick={() => updateDraft("anthropicModel", "")}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 ${smallBtnClassName}`}
                  aria-label="清除模型設定輸入"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Advanced model routing */}
            <details
              open={modelRoutingExpanded}
              onToggle={(e) => setModelRoutingExpanded(e.currentTarget.open)}
              className="mt-4 rounded-xl border border-gray-800 bg-gray-950/40 p-4"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-gray-100">
                <span className="inline-flex items-center gap-2">
                  <SlidersHorizontal className="h-4 w-4 text-gray-400" />
                  進階模型路由
                </span>
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-gray-800 bg-gray-900 text-gray-500">
                  <ChevronDown
                    className={`h-4 w-4 transition-transform duration-200 ${
                      modelRoutingExpanded ? "rotate-180 text-gray-200" : ""
                    }`}
                  />
                </span>
              </summary>
              <p className="mt-2 text-xs text-gray-500">
                Claude Agent SDK 支援依能力等級路由到不同模型。留空時會統一使用上方的預設模型。
              </p>
              <div className="mt-4 grid gap-4">
                {MODEL_ROUTING_FIELDS.map(({ key, label, envVar, hint, patchKey }) => {
                  const settingsValue = settings[patchKey];
                  return (
                    <div key={key}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-medium text-gray-100">{label}</div>
                          <div className="text-xs text-gray-500">{hint}</div>
                        </div>
                        {settingsValue && (
                          <button
                            type="button"
                            onClick={() =>
                              void handleClearField(
                                patchKey,
                                { [patchKey]: "" } as SystemConfigPatch,
                                label,
                              )
                            }
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 text-xs text-gray-600 transition-colors hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-indigo-500/60 focus-visible:outline-none rounded"
                            aria-label={`清除已儲存的 ${label}`}
                          >
                            {clearingField === patchKey ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <X className="h-3 w-3" />
                            )}
                            清除
                          </button>
                        )}
                      </div>
                      <div className="relative mt-1.5">
                        <input
                          value={draft[key]}
                          onChange={(e) => updateDraft(key, e.target.value)}
                          placeholder={envVar}
                          className={`${inputClassName}${draft[key] ? " pr-8" : ""}`}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={saving}
                        />
                        {draft[key] && (
                          <button
                            type="button"
                            onClick={() => updateDraft(key, "")}
                            className={`absolute right-2 top-1/2 -translate-y-1/2 ${smallBtnClassName}`}
                            aria-label={`清除 ${label} 輸入`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          </div>
        </div>

        {/* 進階設定 */}
        <div className={cardClassName}>
          <details>
            <summary className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium text-gray-400 transition-colors hover:text-gray-200">
              <SlidersHorizontal className="h-4 w-4" />
              進階設定
            </summary>
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-200">
                  會話清理延遲（秒）
                </label>
                <p className="mt-0.5 text-xs text-gray-500">
                  會話結束後等待此時間再釋放資源，再次對話時會自動恢復
                </p>
                <input
                  type="number"
                  min={10}
                  max={3600}
                  value={draft.cleanupDelaySeconds}
                  onChange={(e) => updateDraft("cleanupDelaySeconds", e.target.value)}
                  className={`${inputClassName} mt-1.5 max-w-[120px]`}
                  disabled={saving}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-200">
                  最大並行會話數
                </label>
                <p className="mt-0.5 text-xs text-gray-500">
                  同時維持活躍智能體會話的上限，超出時會自動釋放最久未使用的會話（被清理的會話會持久化，下一次對話時可恢復）
                </p>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={draft.maxConcurrentSessions}
                  onChange={(e) => updateDraft("maxConcurrentSessions", e.target.value)}
                  className={`${inputClassName} mt-1.5 max-w-[120px]`}
                  disabled={saving}
                />
              </div>
            </div>
          </details>
        </div>
      </div>

      <TabSaveFooter
        isDirty={isDirty}
        saving={saving}
        disabled={clearingField !== null}
        error={saveError}
        onSave={() => void handleSave()}
        onReset={handleReset}
      />
    </div>
  );
}
