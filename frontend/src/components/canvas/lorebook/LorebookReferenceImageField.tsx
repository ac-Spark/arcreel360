import { useEffect, useRef, useState } from "react";
import { ImagePlus, Upload } from "lucide-react";
import { PreviewableImageFrame } from "@/components/ui/PreviewableImageFrame";

interface LorebookReferenceImageFieldProps {
  name: string;
  savedUrl: string | null;
  resetKey?: string | null;
  onUpload: (file: File) => Promise<void> | void;
}

const REFERENCE_IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp";

function getReferenceStatusLabel(isUploading: boolean, hasPendingReference: boolean): string {
  if (isUploading) {
    return "上傳中...";
  }
  if (hasPendingReference) {
    return "已上傳參考圖";
  }
  return "已儲存參考圖";
}

export function LorebookReferenceImageField({
  name,
  savedUrl,
  resetKey,
  onUpload,
}: LorebookReferenceImageFieldProps) {
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [savingReference, setSavingReference] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setReferenceFile(null);
    setReferencePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, [resetKey]);

  useEffect(() => {
    return () => {
      if (referencePreview) {
        URL.revokeObjectURL(referencePreview);
      }
    };
  }, [referencePreview]);

  const displayedReferenceUrl = referencePreview ?? savedUrl;
  const openReferencePicker = () => fileInputRef.current?.click();
  const referenceStatusLabel = getReferenceStatusLabel(savingReference, referenceFile !== null);

  const handleReferenceChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setReferenceFile(file);
    setReferencePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setSavingReference(true);
    try {
      await onUpload(file);
    } finally {
      setSavingReference(false);
    }
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
          參考圖
        </span>
        {displayedReferenceUrl && (
          <button
            type="button"
            onClick={openReferencePicker}
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
                {referenceStatusLabel}
              </span>
              <button
                type="button"
                onClick={openReferencePicker}
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
          onClick={openReferencePicker}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-gray-700 bg-gray-800/50 px-3 py-4 text-sm text-gray-500 transition-colors hover:border-gray-500 hover:text-gray-300"
        >
          <Upload className="h-4 w-4" />
          上傳參考圖
        </button>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={REFERENCE_IMAGE_ACCEPT}
        onChange={handleReferenceChange}
        className="hidden"
      />
    </div>
  );
}
