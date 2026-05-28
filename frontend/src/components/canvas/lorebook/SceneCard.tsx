import { useEffect, useState } from "react";
import { Mountain, Pencil, Trash2 } from "lucide-react";
import { API } from "@/api";
import { VersionTimeMachine } from "@/components/canvas/timeline/VersionTimeMachine";
import { AspectFrame } from "@/components/ui/AspectFrame";
import { GenerateButton } from "@/components/ui/GenerateButton";
import { PreviewableImageFrame } from "@/components/ui/PreviewableImageFrame";
import { useProjectsStore } from "@/stores/projects-store";
import { useConfirm } from "@/hooks/useConfirm";
import type { Scene } from "@/types";
import { LorebookDescriptionField } from "./LorebookDescriptionField";
import { LorebookReferenceImageField } from "./LorebookReferenceImageField";

interface SceneSavePayload {
  description: string;
}

interface SceneCardProps {
  name: string;
  scene: Scene;
  projectName: string;
  onSave: (name: string, payload: SceneSavePayload) => Promise<void>;
  onGenerate?: (name: string) => void;
  onUploadReference?: (name: string, file: File) => Promise<void> | void;
  onDelete?: (name: string) => Promise<void> | void;
  onRename?: (oldName: string, newName: string) => Promise<void> | void;
  onRestoreVersion?: () => Promise<void> | void;
  generating?: boolean;
}

export function SceneCard({
  name,
  scene,
  projectName,
  onSave,
  onGenerate,
  onUploadReference,
  onDelete,
  onRename,
  onRestoreVersion,
  generating = false,
}: SceneCardProps) {
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
    (s) => (scene.scene_sheet ? s.getAssetFingerprint(scene.scene_sheet) : null),
  );
  const referenceFp = useProjectsStore(
    (s) => (scene.scene_ref ? s.getAssetFingerprint(scene.scene_ref) : null),
  );

  const [description, setDescription] = useState(scene.description);
  const [imgError, setImgError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    setDescription(scene.description);
  }, [scene.description]);

  useEffect(() => {
    setImgError(false);
  }, [scene.scene_sheet, sheetFp]);

  const isDirty = description !== scene.description;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(name, { description });
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
            aria-label="場景名稱"
          />
        ) : (
          <button
            type="button"
            onClick={() => onRename && setRenaming(true)}
            disabled={!onRename}
            className="group flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
            title={onRename ? "點擊改名" : undefined}
          >
            <h3 className="truncate text-lg font-bold text-white">{name}</h3>
            {onRename && (
              <Pencil className="h-3 w-3 shrink-0 text-gray-600 opacity-0 transition-opacity group-hover:opacity-100" />
            )}
          </button>
        )}
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
            <VersionTimeMachine
              projectName={projectName}
              resourceType="scenes"
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
                  <Mountain className="h-10 w-10" />
                  <span className="text-xs">暫無場景圖片</span>
                </div>
              )}
            </AspectFrame>
          </PreviewableImageFrame>
        </div>

        {onUploadReference && (
          <LorebookReferenceImageField
            name={name}
            savedUrl={savedReferenceUrl}
            resetKey={savedReferenceUrl}
            onUpload={(file) => onUploadReference(name, file)}
          />
        )}
      </div>

      <LorebookDescriptionField
        value={description}
        onChange={setDescription}
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

      {onGenerate && (
        <div className="mt-3">
          <GenerateButton
            onClick={() => onGenerate(name)}
            loading={generating}
            label={scene.scene_sheet ? "重新生成設計圖" : "生成設計圖"}
            className="w-full justify-center"
          />
        </div>
      )}
    </div>
  );
}
