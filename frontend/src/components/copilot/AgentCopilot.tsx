import { useState, useRef, useCallback, useEffect } from "react";
import { Bot, Send, Square, Plus, ChevronDown, Trash2, MessageSquare, PanelRightClose, Paperclip, X } from "lucide-react";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { useAssistantStore } from "@/stores/assistant-store";
import { useProjectsStore } from "@/stores/projects-store";
import { useAppStore } from "@/stores/app-store";
import { useAssistantSession } from "@/hooks/useAssistantSession";
import type { AttachedImage } from "@/hooks/useAssistantSession";
import { API } from "@/api";
import { Popover } from "@/components/ui/Popover";
import {
  ASSISTANT_PROVIDER_LABELS,
  inferAssistantProvider,
  resolveAssistantCapabilities,
} from "@/types";
import type { SessionMeta } from "@/types";
import { ContextBanner } from "./ContextBanner";
import { PendingQuestionWizard } from "./PendingQuestionWizard";
import { SlashCommandMenu } from "./SlashCommandMenu";
import type { SlashCommandMenuHandle } from "./SlashCommandMenu";
import { TodoListPanel } from "./TodoListPanel";
import { ChatMessage } from "./chat/ChatMessage";
import { uid } from "@/utils/id";

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TEXTAREA_HEIGHT_VH = 50;

// ---------------------------------------------------------------------------
// SessionSelector — 会话下拉选择器
// ---------------------------------------------------------------------------

function SessionSelector({
  onSwitch,
  onDelete,
}: {
  onSwitch: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}) {
  const { sessions, currentSessionId, isDraftSession } = useAssistantStore();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const displayTitle = isDraftSession ? "新會話" : (currentSession?.title || formatTime(currentSession?.created_at));

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
        title="切換會話"
      >
        <MessageSquare className="h-3 w-3" />
        <span className="max-w-24 truncate">{displayTitle || "無會話"}</span>
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {sessions.length > 0 && (
        <Popover
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={dropdownRef}
          sideOffset={4}
          width="w-64"
          layer="assistantLocalPopover"
          className="rounded-lg border border-gray-700 shadow-xl"
        >
          <div className="max-h-60 overflow-y-auto py-1">
            {sessions.map((session) => {
              const isActive = session.id === currentSessionId;
              const title = session.title || formatTime(session.created_at);
              const sessionCapabilities = resolveAssistantCapabilities(session);
              const canResumeSession = sessionCapabilities.supports_resume;
              const providerLabel = ASSISTANT_PROVIDER_LABELS[sessionCapabilities.provider] ?? sessionCapabilities.provider;
              return (
                <div
                  key={session.id}
                  className={`group flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                    isActive
                      ? "bg-indigo-500/10 text-indigo-300"
                      : "text-gray-300 hover:bg-gray-800"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (!canResumeSession && !isActive) return;
                      onSwitch(session.id);
                      setOpen(false);
                    }}
                    disabled={!canResumeSession && !isActive}
                    className="flex flex-1 items-center gap-2 truncate text-left disabled:cursor-not-allowed disabled:opacity-50"
                    title={!canResumeSession && !isActive ? `${providerLabel} 目前不支援恢復舊會話` : undefined}
                  >
                    <StatusDot status={session.status} />
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    <span className="shrink-0 rounded-full border border-gray-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">
                      {sessionCapabilities.tier}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); if (confirm("確定要刪除這個會話嗎？此操作無法復原。")) onDelete(session.id); }}
                    className="shrink-0 rounded p-0.5 text-gray-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                    title="刪除會話"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </Popover>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    idle: "bg-gray-500",
    running: "bg-amber-400",
    completed: "bg-green-500",
    error: "bg-red-500",
    interrupted: "bg-gray-400",
  };
  return (
    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${colorMap[status] ?? "bg-gray-500"}`} />
  );
}

function formatTime(isoStr: string | undefined): string {
  if (!isoStr) return "新會話";
  try {
    const d = new Date(isoStr);
    return `${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getDate().toString().padStart(2, "0")} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  } catch {
    return "新會話";
  }
}

// ---------------------------------------------------------------------------
// AgentCopilot — 主面板
// ---------------------------------------------------------------------------

export function AgentCopilot() {
  const {
    turns, draftTurn, messagesLoading,
    sending, sessionStatus, pendingQuestion, answeringQuestion, error,
    sessions, currentSessionId,
  } = useAssistantStore();

  const { currentProjectName } = useProjectsStore();
  const toggleAssistantPanel = useAppStore((s) => s.toggleAssistantPanel);
  const { sendMessage, answerQuestion, interrupt, createNewSession, switchSession, deleteSession } =
    useAssistantSession(currentProjectName);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageGenRef = useRef(0);
  const slashMenuRef = useRef<SlashCommandMenuHandle>(null);
  const [localInput, setLocalInput] = useState("");
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [activeProviderId, setActiveProviderId] = useState("claude");
  const allTurns = draftTurn ? [...turns, draftTurn] : turns;
  const currentSession = sessions.find((session) => session.id === currentSessionId) ?? null;
  const providerCapabilities = resolveAssistantCapabilities(
    currentSession,
    activeProviderId || inferAssistantProvider(currentSessionId),
  );
  const providerLabel = ASSISTANT_PROVIDER_LABELS[providerCapabilities.provider] ?? providerCapabilities.provider;
  const isRunning = sessionStatus === "running";
  const slashCommandsEnabled = providerCapabilities.supports_tool_calls || providerCapabilities.supports_subagents;
  const inputDisabled = Boolean(pendingQuestion) || answeringQuestion || isRunning || sending;
  const attachDisabled = inputDisabled || !providerCapabilities.supports_images || attachedImages.length >= MAX_IMAGES;
  const inputPlaceholder = pendingQuestion
    ? "請先回答上方問題"
    : isRunning
      ? "助理正在生成中，可點擊停止中斷"
      : slashCommandsEnabled
        ? "輸入訊息，輸入 / 查看可用技能"
        : "輸入訊息開始對話";

  useEffect(() => {
    let cancelled = false;

    API.getSystemConfig()
      .then((data) => {
        if (!cancelled) setActiveProviderId(data.settings.assistant_provider ?? "claude");
      })
      .catch(() => {
        if (!cancelled) setActiveProviderId("claude");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const addImages = useCallback((files: File[]) => {
    setAttachError(null);
    const gen = imageGenRef.current;
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        setAttachError(`圖片「${file.name}」超過 5MB，已跳過`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        if (imageGenRef.current !== gen) return; // stale — message already sent
        const dataUrl = e.target?.result as string;
        setAttachedImages((prev) => {
          if (prev.length >= MAX_IMAGES) return prev;
          return [...prev, { id: uid(), dataUrl, mimeType: file.type }];
        });
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    e.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter(Boolean) as File[];
    addImages(files);
  }, [addImages]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    const hasFiles = Array.from(e.dataTransfer.items).some((i) => i.kind === "file");
    if (!hasFiles) return;
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length > 0) addImages(files);
  }, [addImages]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) addImages(files);
    e.target.value = "";
  }, [addImages]);

  const removeImage = useCallback((id: string) => {
    setAttachedImages((prev) => prev.filter((img) => img.id !== id));
    setAttachError(null);
  }, []);

  const handleSend = useCallback(() => {
    if (inputDisabled || (!localInput.trim() && attachedImages.length === 0)) return;
    imageGenRef.current += 1; // invalidate pending FileReader callbacks
    sendMessage(localInput.trim(), attachedImages.length > 0 ? attachedImages : undefined);
    setLocalInput("");
    setAttachedImages([]);
    setAttachError(null);
    setShowSlashMenu(false);
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [inputDisabled, localInput, attachedImages, sendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Delegate to slash menu when open
    if (showSlashMenu && slashMenuRef.current) {
      const consumed = slashMenuRef.current.handleKeyDown(e.key);
      if (consumed) {
        e.preventDefault();
        if (e.key === "Escape") setShowSlashMenu(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, showSlashMenu]);

  // Track the slash "/" position so we know where the command token starts
  const slashPosRef = useRef(-1);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const cursor = e.target.selectionStart ?? val.length;
    setLocalInput(val);

    // Check text left of cursor: trigger menu when "/" is at start or after whitespace/newline
    const textBeforeCursor = val.slice(0, cursor);
    const lastSlash = textBeforeCursor.lastIndexOf("/");
    if (lastSlash >= 0) {
      const charBefore = lastSlash > 0 ? textBeforeCursor[lastSlash - 1] : undefined;
      const atBoundary = charBefore === undefined || /\s/.test(charBefore);
      const afterSlash = textBeforeCursor.slice(lastSlash + 1);
      const noSpaceAfterSlash = !afterSlash.includes(" ");
      if (slashCommandsEnabled && atBoundary && noSpaceAfterSlash) {
        setShowSlashMenu(true);
        slashPosRef.current = lastSlash;
      } else {
        setShowSlashMenu(false);
        slashPosRef.current = -1;
      }
    } else {
      setShowSlashMenu(false);
      slashPosRef.current = -1;
    }

    // Auto-resize: grow upward until 50vh, then scroll
    const el = e.target;
    el.style.height = "auto";
    const maxH = window.innerHeight * (MAX_TEXTAREA_HEIGHT_VH / 100);
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
    el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
  }, [slashCommandsEnabled]);

  // Derive slash filter from input (text after "/" up to cursor)
  const slashFilter = showSlashMenu && slashPosRef.current >= 0
    ? localInput.slice(slashPosRef.current + 1).split(/\s/)[0]
    : "";

  const handleSlashSelect = useCallback((cmd: string) => {
    // Replace the "/filter" token with the selected command, keep surrounding text
    const pos = slashPosRef.current;
    if (pos >= 0) {
      const before = localInput.slice(0, pos);
      // Find end of the slash token (next whitespace or end of string)
      const afterSlash = localInput.slice(pos);
      const tokenEnd = afterSlash.search(/\s/);
      const after = tokenEnd >= 0 ? localInput.slice(pos + tokenEnd) : "";
      setLocalInput(before + cmd + " " + after.trimStart());
    } else {
      setLocalInput(localInput + cmd + " ");
    }
    setShowSlashMenu(false);
    slashPosRef.current = -1;
    textareaRef.current?.focus();
  }, [localInput]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [allTurns.length]);

  return (
    <div className="relative isolate flex h-full flex-col">
      {/* Header */}
      <div className="flex h-10 items-center justify-between border-b border-gray-800 px-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleAssistantPanel}
            className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
            title="收起助理面板"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
          <Bot className="h-4 w-4 text-indigo-400" />
          <span className="text-sm font-medium text-gray-300">ArcReel 智能體</span>
          <span className="rounded-full border border-gray-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">
            {providerLabel}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {isRunning && (
            <span className="flex items-center gap-1.5 text-xs text-indigo-400 mr-1">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />
              思考中
            </span>
          )}
          <SessionSelector onSwitch={switchSession} onDelete={deleteSession} />
          <button
            type="button"
            onClick={createNewSession}
            className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
            title="新建會話"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Context banner */}
      <ContextBanner />

      {(!providerCapabilities.supports_resume || !slashCommandsEnabled) && (
        <div className="border-b border-amber-900/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
          {!providerCapabilities.supports_resume && (
            <span>目前 provider 不支援恢復舊會話；lite 會話在程序重啟後只能查看歷史，不能繼續傳送。</span>
          )}
          {!providerCapabilities.supports_resume && !slashCommandsEnabled && <span className="mx-1 text-amber-500">·</span>}
          {!slashCommandsEnabled && (
            <span>目前 provider 不支援技能快捷指令與 Claude-only 進階能力。</span>
          )}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-3 py-3 space-y-3">
        {allTurns.length === 0 && !messagesLoading && (
          <div className="flex h-full flex-col items-center justify-center text-center text-gray-500">
            <Bot className="mb-3 h-8 w-8 text-gray-600" />
            <p className="text-sm">在下方輸入訊息開始對話</p>
            {slashCommandsEnabled ? (
              <p className="mt-1 text-xs text-gray-600">輸入 / 可快速呼叫技能</p>
            ) : (
              <p className="mt-1 text-xs text-gray-600">目前 provider 僅提供基礎對話能力</p>
            )}
          </div>
        )}
        {allTurns.map((turn, i) => (
          <ChatMessage key={turn.uuid || `turn-${i}`} message={turn} />
        ))}
      </div>

      {pendingQuestion && (
        <PendingQuestionWizard
          pendingQuestion={pendingQuestion}
          answeringQuestion={answeringQuestion}
          error={error}
          onSubmitAnswers={answerQuestion}
        />
      )}

      <TodoListPanel turns={turns} draftTurn={draftTurn} />

      {!pendingQuestion && (error || attachError) && (
        <div className="border-t border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error || attachError}
        </div>
      )}

      {/* Input area */}
      <div className="border-t border-gray-800 p-3">
        {/* Thumbnail strip */}
        {attachedImages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachedImages.map((img) => (
              <div key={img.id} className="relative">
                <button
                  type="button"
                  className="h-16 w-16 cursor-pointer border-0 bg-transparent p-0"
                  onClick={() => setLightboxSrc(img.dataUrl)}
                  aria-label="點擊放大圖片"
                >
                  <img
                    src={img.dataUrl}
                    alt="附件預覽"
                    className="h-16 w-16 rounded-md object-cover border border-gray-600"
                  />
                </button>
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-gray-900 text-gray-300 hover:bg-red-500 hover:text-white"
                  aria-label="移除圖片"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          className={`relative flex items-end gap-2 rounded-lg border bg-gray-800 px-3 py-2 transition-colors ${
            isDragOver ? "border-indigo-500 bg-indigo-500/10" : "border-gray-700"
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {showSlashMenu && (
            <SlashCommandMenu
              ref={slashMenuRef}
              filter={slashFilter}
              onSelect={handleSlashSelect}
            />
          )}
          <textarea
            ref={textareaRef}
            role="combobox"
            value={localInput}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={inputPlaceholder}
            rows={1}
            aria-label="助理輸入"
            aria-expanded={showSlashMenu}
            aria-controls={showSlashMenu ? "slash-command-menu" : undefined}
            aria-activedescendant={slashMenuRef.current?.activeDescendantId}
            className="flex-1 resize-none bg-transparent text-sm text-gray-200 placeholder-gray-500 outline-none overflow-hidden"
            style={{ maxHeight: `${MAX_TEXTAREA_HEIGHT_VH}vh` }}
            disabled={inputDisabled}
          />

          {/* Attachment button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={attachDisabled}
            className="shrink-0 rounded p-1.5 text-gray-400 hover:bg-gray-700 hover:text-gray-200 disabled:opacity-30"
            title={
              !providerCapabilities.supports_images
                ? "目前 provider 不支援圖片輸入"
                : attachedImages.length >= MAX_IMAGES
                  ? `最多附加 ${MAX_IMAGES} 張圖片`
                  : "附加圖片"
            }
            aria-label="附加圖片"
          >
            <Paperclip className="h-4 w-4" />
          </button>

          {isRunning ? (
            <button
              onClick={interrupt}
              className="shrink-0 rounded p-1.5 text-red-400 hover:bg-gray-700"
              title="中斷會話"
              aria-label="中斷會話"
            >
              <Square className="h-4 w-4" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={(!localInput.trim() && attachedImages.length === 0) || inputDisabled}
              className="shrink-0 rounded p-1.5 text-indigo-400 hover:bg-gray-700 disabled:opacity-30"
              title="傳送訊息"
              aria-label="傳送訊息"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*"
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>

      {lightboxSrc && (
        <ImageLightbox
          src={lightboxSrc}
          alt="附件預覽"
          onClose={() => setLightboxSrc(null)}
        />
      )}
    </div>
  );
}
