/**
 * Assistant / agent runtime type definitions.
 *
 * Maps to backend models in:
 * - webui/server/agent_runtime/models.py (SessionMeta, SessionStatus, AssistantSnapshotV2)
 * - webui/server/agent_runtime/turn_grouper.py (Turn, ContentBlock structure)
 * - webui/server/agent_runtime/service.py (SkillInfo, stream events)
 */

export type SessionStatus = "idle" | "running" | "completed" | "error" | "interrupted";

export type AssistantProviderTier = "lite" | "workflow-grade" | "full";

export interface AssistantProviderCapabilities {
  provider: string;
  tier: AssistantProviderTier;
  supports_streaming: boolean;
  supports_images: boolean;
  supports_tool_calls: boolean;
  supports_interrupt: boolean;
  supports_resume: boolean;
  supports_subagents: boolean;
  supports_permission_hooks: boolean;
}

export const ASSISTANT_PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude Full",
  "gemini-lite": "Gemini Lite",
  "openai-lite": "OpenAI Lite",
};

export const ASSISTANT_PROVIDER_CAPABILITIES: Record<string, AssistantProviderCapabilities> = {
  claude: {
    provider: "claude",
    tier: "full",
    supports_streaming: true,
    supports_images: true,
    supports_tool_calls: true,
    supports_interrupt: true,
    supports_resume: true,
    supports_subagents: true,
    supports_permission_hooks: true,
  },
  "gemini-lite": {
    provider: "gemini-lite",
    tier: "lite",
    supports_streaming: true,
    supports_images: true,
    supports_tool_calls: false,
    supports_interrupt: true,
    supports_resume: false,
    supports_subagents: false,
    supports_permission_hooks: false,
  },
  "openai-lite": {
    provider: "openai-lite",
    tier: "lite",
    supports_streaming: true,
    supports_images: true,
    supports_tool_calls: false,
    supports_interrupt: true,
    supports_resume: false,
    supports_subagents: false,
    supports_permission_hooks: false,
  },
};

export function inferAssistantProvider(sessionId?: string | null): string {
  if (!sessionId) return "claude";
  if (sessionId.startsWith("gemini:")) return "gemini-lite";
  if (sessionId.startsWith("openai:")) return "openai-lite";
  return "claude";
}

export function resolveAssistantCapabilities(
  sessionLike?: Pick<SessionMeta, "id" | "provider" | "capabilities"> | null,
  fallbackProvider?: string | null,
): AssistantProviderCapabilities {
  if (sessionLike?.capabilities) return sessionLike.capabilities;
  const provider = sessionLike?.provider || fallbackProvider || inferAssistantProvider(sessionLike?.id);
  return ASSISTANT_PROVIDER_CAPABILITIES[provider] ?? ASSISTANT_PROVIDER_CAPABILITIES.claude;
}

export interface SessionMeta {
  id: string;              // 现在就是 sdk_session_id
  provider?: string;
  capabilities?: AssistantProviderCapabilities;
  project_name: string;
  title: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
}

export interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "skill_content" | "task_progress" | "interrupt_notice" | "image";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  result?: string;
  is_error?: boolean;
  skill_content?: string;
  tool_use_id?: string;
  content?: string;
  // image block fields
  source?: { type: "base64"; media_type: string; data: string };
  // task_progress fields
  task_id?: string;
  status?: string;
  description?: string;
  summary?: string;
  task_status?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
}

export interface Turn {
  type: "user" | "assistant" | "system";
  content: ContentBlock[];
  uuid?: string;
  timestamp?: string;
  subtype?: string;
}

export interface PendingQuestion {
  question_id: string;
  questions: Array<{
    header?: string;
    question: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}

export interface AssistantSnapshot {
  session_id: string;
  provider?: string;
  capabilities?: AssistantProviderCapabilities;
  status: SessionStatus;
  turns: Turn[];
  draft_turn: Turn | null;
  pending_questions: PendingQuestion[];
}

export interface SkillInfo {
  name: string;
  description: string;
  scope: "project" | "user";
  path: string;
  label?: string;
  icon?: string;
}

export interface TodoItem {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
}
