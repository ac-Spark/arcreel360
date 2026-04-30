import { create } from "zustand";
import { API } from "@/api";

// ---------------------------------------------------------------------------
// ConfigIssue
// ---------------------------------------------------------------------------

export interface ConfigIssue {
  key: string;
  tab: "agent" | "providers" | "media" | "usage";
  label: string;
}

const GEMINI_ASSISTANT_PROVIDER_IDS = new Set(["gemini-aistudio", "gemini-vertex"]);
const OPENAI_ASSISTANT_PROVIDER_IDS = new Set(["openai"]);

async function getConfigIssues(): Promise<ConfigIssue[]> {
  const issues: ConfigIssue[] = [];

  const [{ providers }, configRes] = await Promise.all([
    API.getProviders(),
    API.getSystemConfig(),
  ]);

  const settings = configRes.settings;
  const assistantProvider = settings.assistant_provider || "claude";
  const readyProviders = providers.filter((p) => p.status === "ready");

  if (assistantProvider === "gemini-lite") {
    const hasGeminiAssistantProvider = readyProviders.some((p) => GEMINI_ASSISTANT_PROVIDER_IDS.has(p.id));
    if (!hasGeminiAssistantProvider) {
      issues.push({
        key: "assistant-gemini",
        tab: "providers",
        label: "Gemini 智能体未配置可用的 Gemini 文本供应商",
      });
    }
  }

  if (assistantProvider === "openai-lite") {
    const hasOpenAIAssistantProvider = readyProviders.some((p) => OPENAI_ASSISTANT_PROVIDER_IDS.has(p.id));
    if (!hasOpenAIAssistantProvider) {
      issues.push({
        key: "assistant-openai",
        tab: "providers",
        label: "OpenAI / ChatGPT 智能体未配置可用的 OpenAI 文本供应商",
      });
    }
  }

  // Check any provider supports each media type
  const hasMediaType = (type: string) =>
    readyProviders.some((p) => p.media_types.includes(type));

  if (!hasMediaType("video")) {
    issues.push({
      key: "no-video-provider",
      tab: "providers",
      label: "未配置支持视频生成的供应商",
    });
  }
  if (!hasMediaType("image")) {
    issues.push({
      key: "no-image-provider",
      tab: "providers",
      label: "未配置支持图片生成的供应商",
    });
  }
  if (!hasMediaType("text")) {
    issues.push({
      key: "no-text-provider",
      tab: "providers",
      label: "未配置支持文本生成的供应商",
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface ConfigStatusState {
  issues: ConfigIssue[];
  isComplete: boolean;
  loading: boolean;
  initialized: boolean;
  fetch: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const useConfigStatusStore = create<ConfigStatusState>((set, get) => ({
  issues: [],
  isComplete: true,
  loading: false,
  initialized: false,

  fetch: async () => {
    if (get().initialized || get().loading) return;
    await get().refresh();
  },

  refresh: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const issues = await getConfigIssues();
      set({ issues, isComplete: issues.length === 0, loading: false, initialized: true });
    } catch {
      set({ loading: false });
    }
  },
}));
