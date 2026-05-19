import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, Mountain, Trash2, Upload } from "lucide-react";
import { API } from "@/api";
import { AspectFrame } from "@/components/ui/AspectFrame";
import { PreviewableImageFrame } from "@/components/ui/PreviewableImageFrame";
import { useProjectsStore } from "@/stores/projects-store";
import { useConfirm } from "@/hooks/useConfirm";
import type { Scene } from "@/types";
import { UseUploadedAsFinalToggle } from "./UseUploadedAsFinalToggle";

interface SceneSavePayload {
  description: string;
  referenceFile?: File | null;
}

interface SceneCardProps {
  name: string;
  scene: Scene;
  projectName: string;
  onSave: (name: string, payload: SceneSavePayload) => Promise<void>;
  onToggleUseUploaded: (name: string, value: boolean) => Promise<void> | void;
  onDelete?: (name: string) => Promise<void> | void;
}

export function SceneCard({
  name,
  scene,
  projectName,
  onSave,
  onToggleUseUploaded,
  onDelete,
}: SceneCardProps) {
  const confirm = useConfirm();

  const sheetFp = useProjectsStore(
    (s) => (scene.scene_sheet ? s.getAssetFingerprint(scene.scene_sheet) : null),
  );
  const referenceFp = useProjectsStore(
    (s) => (scene.scene_ref ? s.getAssetFingerprint(scene.scene_ref) : null),
  );

  const [description, setDescription] = useState(scene.description);
  const [imgError, setImgError] = useState(false);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDescription(scene.description);
  }, [scene.description]);

  useEffect(() => {
    setImgError(false);
  }, [scene.scene_sheet, sheetFp]);

  useEffect(() => {
    setReferenceFile(null);
    setReferencePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, [scene.scene_ref]);

  useEffect(() => {
    return () => {
      if (referencePreview) {
        URL.revokeObjectURL(referencePreview);
      }
    };
  }, [referencePreview]);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  useEffect(() => {
    autoResize();
  }, [autoResize, description]);

  const isDirty =
    description !== scene.description || referenceFile !== null;

  const handleReferenceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setReferenceFile(file);
    setReferencePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    e.target.value = "";
  };

  const clearPendingReference = () => {
    setReferenceFile(null);
    setReferencePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(name, { description, referenceFile });
    } finally {
      setSaving(false);
    }
  };

  const sheetUrl = scene.scene_sheet
    ? API.getFileUrl(projectName, scene.scene_sheet, sheetFp)
    : null;

  const savedReferenceUrl = scene.scene_ref
    ? API.getFileUrl(projectName, scene.scene_ref, referenceFp)
    : null;

  const displayedReferenceUrl = referencePreview ?? savedReferenceUrl;
  const hasSavedReference = Boolean(savedReferenceUrl) && !referencePreview;

  return (
    <div
      className="rounded-xl border border-gray-800 bg-gray-900 p-5"
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
      {/* ---- Header ---- */}
      <div className="mb-4 flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-lg font-bold text-white">
          {name}
        </h3>
        <span className="shrink-0 rounded-full bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-300">
          場景
        </span>
        {onDelete && (
          <button
            type="button"
            onClick={async () => {
              const ok = await confirm({
                message: `確定要刪除場景「${name}」？此操作無法復原。`,
                danger: true,
              });
              if (ok) void onDelete(name);
            }}
            className="shrink-0 rounded p-1.5 text-gray-500 transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/60"
            title="刪除場景"
            aria-label={`刪除場景 ${name}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ---- Images ---- */}
      <div className="mb-4 space-y-3">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              場景設計圖
            </span>
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
                  <Mountain className="h-10 w-10" />
                  <span className="text-xs">尚無設計圖</span>
                </div>
              )}
            </AspectFrame>
          </PreviewableImageFrame>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              參考圖
            </span>
            {(referenceFile || hasSavedReference) && (
              <button
                type="button"
                onClick={() =>
                  referenceFile
                    ? clearPendingReference()
                    : fileInputRef.current?.click()
                }
                className="text-xs text-gray-400 transition-colors hover:text-gray-200"
              >
                {referenceFile ? "取消待上傳" : "替換"}
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
                    {referenceFile ? "待儲存參考圖" : "已儲存參考圖"}
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
      </div>

      {/* ---- Use-uploaded-as-final toggle ---- */}
      <UseUploadedAsFinalToggle
        checked={Boolean(scene.use_uploaded_as_final)}
        onChange={(value) => void onToggleUseUploaded(name, value)}
      />

      {/* ---- Description ---- */}
      <label className="mt-3 block text-xs font-medium text-gray-400">描述</label>
      <textarea
        ref={textareaRef}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onInput={autoResize}
        rows={3}
        className="mt-1 w-full resize-none overflow-hidden rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
        placeholder="輸入場景描述..."
      />

      {isDirty && (
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="mt-3 rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "儲存中..." : "儲存"}
        </button>
      )}
    </div>
  );
}
