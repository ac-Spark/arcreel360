import { useState, useRef, useEffect, useCallback } from "react";
import { Pencil, Puzzle, Trash2 } from "lucide-react";
import { API } from "@/api";
import { VersionTimeMachine } from "@/components/canvas/timeline/VersionTimeMachine";
import { AspectFrame } from "@/components/ui/AspectFrame";
import { GenerateButton } from "@/components/ui/GenerateButton";
import { PreviewableImageFrame } from "@/components/ui/PreviewableImageFrame";
import { useProjectsStore } from "@/stores/projects-store";
import type { Clue } from "@/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ClueCardProps {
  name: string;
  clue: Clue;
  projectName: string;
  onUpdate: (name: string, updates: Partial<Clue>) => void;
  onGenerate: (name: string) => void;
  onDelete?: (name: string) => Promise<void> | void;
  onRename?: (oldName: string, newName: string) => Promise<void> | void;
  onRestoreVersion?: () => Promise<void> | void;
  generating?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<string, string> = {
  prop: "道具",
  location: "環境",
};

// ---------------------------------------------------------------------------
// ClueCard
// ---------------------------------------------------------------------------

export function ClueCard({
  name,
  clue,
  projectName,
  onUpdate,
  onGenerate,
  onDelete,
  onRename,
  onRestoreVersion,
  generating = false,
}: ClueCardProps) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(name);

  useEffect(() => {
    setNameDraft(name);
  }, [name]);

  const commitRename = async () => {
    const trimmed = nameDraft.trim();
    setRenaming(false);
    if (!trimmed || trimmed === name || !onRename) {
      setNameDraft(name);
      return;
    }
    await onRename(name, trimmed);
  };
  const sheetFp = useProjectsStore(
    (s) => clue.clue_sheet ? s.getAssetFingerprint(clue.clue_sheet) : null,
  );
  const [description, setDescription] = useState(clue.description);
  const [imgError, setImgError] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  const isDirty = description !== clue.description;

  useEffect(() => {
    setDescription(clue.description);
  }, [clue.description]);

  useEffect(() => {
    setImgError(false);
  }, [clue.clue_sheet, sheetFp]);

  // Auto-resize textarea.
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  useEffect(() => {
    autoResize();
  }, [description, autoResize]);

  const handleSave = () => {
    onUpdate(name, { description });
  };

  const sheetUrl = clue.clue_sheet
    ? API.getFileUrl(projectName, clue.clue_sheet, sheetFp)
    : null;

  return (
    <div
      className="bg-gray-900 border border-gray-800 rounded-xl p-5"
      data-workspace-editing={isEditing || isDirty ? "true" : undefined}
      onFocusCapture={() => setIsEditing(true)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
          return;
        }
        setIsEditing(false);
      }}
    >
      {/* ---- Header: name + badges ---- */}
      <div className="mb-4 flex items-center gap-2">
        {renaming ? (
          <input
            type="text"
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitRename();
              } else if (e.key === "Escape") {
                setNameDraft(name);
                setRenaming(false);
              }
            }}
            className="min-w-0 flex-1 rounded border border-indigo-500 bg-gray-800 px-2 py-0.5 text-lg font-bold text-white focus:outline-none"
            aria-label="道具名稱"
          />
        ) : (
          <button
            type="button"
            onClick={() => onRename && setRenaming(true)}
            disabled={!onRename}
            className="group flex min-w-0 items-center gap-1.5 text-left disabled:cursor-default"
            title={onRename ? "點擊改名" : undefined}
          >
            <h3 className="text-lg font-bold text-white truncate">{name}</h3>
            {onRename && (
              <Pencil className="h-3 w-3 shrink-0 text-gray-600 opacity-0 transition-opacity group-hover:opacity-100" />
            )}
          </button>
        )}

        <span className="shrink-0 rounded-full bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-300">
          {TYPE_LABELS[clue.type] ?? clue.type}
        </span>

        {clue.importance === "major" ? (
          <span className="shrink-0 rounded-full bg-indigo-500/10 px-2 py-0.5 text-xs font-medium text-indigo-400 border border-indigo-500/20">
            重要
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-400">
            次要
          </span>
        )}

        {onDelete && (
          <button
            type="button"
            onClick={() => {
              if (confirm(`確定要刪除道具/場景「${name}」？此操作無法復原。`)) {
                void onDelete(name);
              }
            }}
            className="ml-auto shrink-0 rounded p-1.5 text-gray-500 transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/60"
            title="刪除"
            aria-label={`刪除 ${name}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ---- Image area ---- */}
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            道具設計圖
          </span>
          <VersionTimeMachine
            projectName={projectName}
            resourceType="clues"
            resourceId={name}
            onRestore={onRestoreVersion}
          />
        </div>
        <PreviewableImageFrame
          src={sheetUrl && !imgError ? sheetUrl : null}
          alt={`${name} 設計圖`}
        >
          <AspectFrame ratio="16:9">
            {sheetUrl && !imgError ? (
              <img
                src={sheetUrl}
                alt={`${name} 設計圖`}
                className="h-full w-full object-cover"
                onError={() => setImgError(true)}
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-gray-500">
                <Puzzle className="h-10 w-10" />
                <span className="text-xs">點選生成</span>
              </div>
            )}
          </AspectFrame>
        </PreviewableImageFrame>
      </div>

      {/* ---- Description ---- */}
      <textarea
        ref={textareaRef}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onInput={autoResize}
        rows={2}
        className="mb-3 w-full resize-none overflow-hidden bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
        placeholder="輸入道具描述..."
      />

      {isDirty && (
        <button
          type="button"
          onClick={handleSave}
          className="mb-3 rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
        >
          儲存
        </button>
      )}

      {clue.importance === "major" && (
        <GenerateButton
          onClick={() => onGenerate(name)}
          loading={generating}
          label={clue.clue_sheet ? "重新生成設計圖" : "生成設計圖"}
          className="w-full justify-center"
        />
      )}
    </div>
  );
}
