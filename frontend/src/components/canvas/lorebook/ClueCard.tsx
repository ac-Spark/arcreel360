import { useState, useRef, useEffect, useCallback } from "react";
import { ImagePlus, Pencil, Puzzle, Trash2, Upload } from "lucide-react";
import { API } from "@/api";
import { VersionTimeMachine } from "@/components/canvas/timeline/VersionTimeMachine";
import { AspectFrame } from "@/components/ui/AspectFrame";
import { GenerateButton } from "@/components/ui/GenerateButton";
import { PreviewableImageFrame } from "@/components/ui/PreviewableImageFrame";
import { useProjectsStore } from "@/stores/projects-store";
import { useConfirm } from "@/hooks/useConfirm";
import type { Clue } from "@/types";
import { UseUploadedAsFinalToggle } from "./UseUploadedAsFinalToggle";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ClueCardProps {
  name: string;
  clue: Clue;
  projectName: string;
  onUpdate: (name: string, updates: Partial<Clue>) => void;
  onGenerate: (name: string) => void;
  /** 上傳參考圖（multipart）。提供時才顯示參考圖上傳入口。 */
  onUploadReference?: (name: string, file: File) => Promise<void> | void;
  /** 切換「直接以上傳圖為最終成品」。 */
  onToggleUseUploaded?: (name: string, value: boolean) => Promise<void> | void;
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
  onUploadReference,
  onToggleUseUploaded,
  onDelete,
  onRename,
  onRestoreVersion,
  generating = false,
}: ClueCardProps) {
  const confirm = useConfirm();
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
  const referenceFp = useProjectsStore(
    (s) => clue.reference_image ? s.getAssetFingerprint(clue.reference_image) : null,
  );
  const [description, setDescription] = useState(clue.description);
  const [imgError, setImgError] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [savingReference, setSavingReference] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isDirty = description !== clue.description;

  useEffect(() => {
    setDescription(clue.description);
  }, [clue.description]);

  useEffect(() => {
    setImgError(false);
  }, [clue.clue_sheet, sheetFp]);

  useEffect(() => {
    setReferenceFile(null);
    setReferencePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, [clue.reference_image]);

  useEffect(() => {
    return () => {
      if (referencePreview) {
        URL.revokeObjectURL(referencePreview);
      }
    };
  }, [referencePreview]);

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

  const handleReferenceChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !onUploadReference) return;

    setReferenceFile(file);
    setReferencePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setSavingReference(true);
    try {
      await onUploadReference(name, file);
    } finally {
      setSavingReference(false);
    }
  };

  const sheetUrl = clue.clue_sheet
    ? API.getFileUrl(projectName, clue.clue_sheet, sheetFp)
    : null;

  const savedReferenceUrl = clue.reference_image
    ? API.getFileUrl(projectName, clue.reference_image, referenceFp)
    : null;

  const displayedReferenceUrl = referencePreview ?? savedReferenceUrl;

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
            onClick={async () => {
              const ok = await confirm({
                message: `確定要刪除道具/場景「${name}」？此操作無法復原。`,
                danger: true,
              });
              if (ok) void onDelete(name);
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

      {/* ---- Reference image upload ---- */}
      {onUploadReference && (
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              參考圖
            </span>
            {displayedReferenceUrl && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="text-xs text-gray-400 transition-colors hover:text-gray-200"
              >
                替換
              </button>
            )}
          </div>

          {displayedReferenceUrl ? (
            <PreviewableImageFrame
              src={displayedReferenceUrl}
              alt={`${name} 參考圖`}
              buttonClassName="right-2.5 top-2.5"
            >
              <div className="relative overflow-hidden rounded-lg border border-gray-700 bg-gray-800">
                <img
                  src={displayedReferenceUrl}
                  alt={`${name} 參考圖`}
                  className="h-28 w-full object-cover"
                />
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
                  <span className="flex items-center gap-1.5 text-xs text-gray-200">
                    <ImagePlus className="h-3.5 w-3.5" />
                    {savingReference
                      ? "上傳中..."
                      : referenceFile
                        ? "已上傳參考圖"
                        : "已儲存參考圖"}
                  </span>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded bg-black/40 px-2 py-1 text-xs text-gray-200 transition-colors hover:bg-black/60"
                  >
                    更換
                  </button>
                </div>
              </div>
            </PreviewableImageFrame>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-gray-700 bg-gray-800/50 px-3 py-4 text-sm text-gray-500 transition-colors hover:border-gray-500 hover:text-gray-300"
            >
              <Upload className="h-4 w-4" />
              上傳參考圖
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".png,.jpg,.jpeg,.webp"
            onChange={handleReferenceChange}
            className="hidden"
          />
        </div>
      )}

      {/* ---- Use-uploaded-as-final toggle ---- */}
      {onToggleUseUploaded && (
        <div className="mb-3">
          <UseUploadedAsFinalToggle
            checked={Boolean(clue.use_uploaded_as_final)}
            onChange={(value) => void onToggleUseUploaded(name, value)}
          />
        </div>
      )}

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
