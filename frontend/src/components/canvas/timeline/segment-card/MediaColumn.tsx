import { ImageIcon, Film } from "lucide-react";
import { API } from "@/api";
import { useProjectsStore } from "@/stores/projects-store";
import { VersionTimeMachine } from "@/components/canvas/timeline/VersionTimeMachine";
import { AspectFrame } from "@/components/ui/AspectFrame";
import { GenerateButton } from "@/components/ui/GenerateButton";
import { ImageFlipReveal } from "@/components/ui/ImageFlipReveal";
import { PreviewableImageFrame } from "@/components/ui/PreviewableImageFrame";
import { PreviewableVideoFrame } from "@/components/ui/PreviewableVideoFrame";
import { LorebookReferenceImageField } from "@/components/canvas/lorebook/LorebookReferenceImageField";
import type { Segment } from "./types";

interface MediaColumnProps {
  segment: Segment;
  aspectRatio: string;
  projectName: string;
  segmentId: string;
  onGenerateStoryboard?: (segmentId: string) => void;
  onGenerateVideo?: (segmentId: string) => void;
  onRestoreStoryboard?: () => Promise<void> | void;
  onRestoreVideo?: () => Promise<void> | void;
  generatingStoryboard?: boolean;
  generatingVideo?: boolean;
  onUploadReference?: (segmentId: string, file: File) => Promise<void> | void;
  onRemoveReference?: (segmentId: string) => Promise<void> | void;
  stage?: "storyboard" | "video";
}

/** Simple video player with poster thumbnail and lazy preload. */
function VideoPlayer({ src, poster }: { src: string; poster?: string | null }) {
  return (
    <video
      src={src}
      poster={poster ?? undefined}
      className="h-full w-full bg-black object-contain"
      controls
      playsInline
      preload={poster ? "none" : "metadata"}
    />
  );
}

export function MediaColumn({
  segment,
  aspectRatio,
  projectName,
  segmentId,
  onGenerateStoryboard,
  onGenerateVideo,
  onRestoreStoryboard,
  onRestoreVideo,
  generatingStoryboard,
  generatingVideo,
  onUploadReference,
  onRemoveReference,
  stage,
}: MediaColumnProps) {
  const assets = segment.generated_assets;
  const storyboardFp = useProjectsStore(
    (s) => assets?.storyboard_image ? s.getAssetFingerprint(assets.storyboard_image) : null,
  );
  const videoFp = useProjectsStore(
    (s) => assets?.video_clip ? s.getAssetFingerprint(assets.video_clip) : null,
  );
  const thumbnailFp = useProjectsStore(
    (s) => assets?.video_thumbnail ? s.getAssetFingerprint(assets.video_thumbnail) : null,
  );
  const refImageFp = useProjectsStore(
    (s) => segment.reference_image ? s.getAssetFingerprint(segment.reference_image) : null,
  );
  const storyboardUrl = assets?.storyboard_image
    ? API.getFileUrl(projectName, assets.storyboard_image, storyboardFp)
    : null;
  const refImageUrl = segment.reference_image
    ? API.getFileUrl(projectName, segment.reference_image, refImageFp)
    : null;
  const videoUrl = assets?.video_clip
    ? API.getFileUrl(projectName, assets.video_clip, videoFp)
    : null;
  const thumbnailUrl = assets?.video_thumbnail
    ? API.getFileUrl(projectName, assets.video_thumbnail, thumbnailFp)
    : null;

  // Normalize aspect ratio to the union type expected by AspectFrame
  const normalizedRatio = (
    aspectRatio === "9:16" || aspectRatio === "16:9" ? aspectRatio : "16:9"
  ) as "9:16" | "16:9";

  const maxWClass = normalizedRatio === "9:16" ? "max-w-[180px]" : "max-w-[320px]";

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* ---- Storyboard image ---- */}
      {(stage === undefined || stage === "storyboard") && (
        <div className={`mx-auto w-full ${maxWClass}`}>
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <ImageIcon className="h-3 w-3 text-gray-500" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">分鏡圖</span>
            </div>
            <VersionTimeMachine
              projectName={projectName}
              resourceType="storyboards"
              resourceId={segmentId}
              onRestore={onRestoreStoryboard}
            />
          </div>
          <PreviewableImageFrame src={storyboardUrl} alt={`${segmentId} 分鏡圖`}>
            <AspectFrame ratio={normalizedRatio}>
              <ImageFlipReveal
                src={storyboardUrl}
                alt={`${segmentId} 分鏡圖`}
                loading="lazy"
                className="h-full w-full object-cover"
                fallback={
                  <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-gray-600">
                    <ImageIcon className="h-8 w-8" />
                    <span className="text-xs">暫無分鏡</span>
                  </div>
                }
              />
            </AspectFrame>
          </PreviewableImageFrame>
          <div className="mt-2">
            <GenerateButton
              onClick={() => onGenerateStoryboard?.(segmentId)}
              loading={generatingStoryboard}
              label="生成分鏡"
              className="w-full justify-center"
            />
          </div>
          {onUploadReference && (
            <div className="mt-3">
              <LorebookReferenceImageField
                name={segmentId}
                savedUrl={refImageUrl}
                onUpload={(file) => onUploadReference(segmentId, file)}
                onRemove={onRemoveReference ? () => onRemoveReference(segmentId) : undefined}
              />
            </div>
          )}
        </div>
      )}

      {/* ---- Read-only Storyboard Thumbnail when in video stage ---- */}
      {stage === "video" && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/40 p-2 text-xs text-gray-400">
          <div className="h-10 w-10 shrink-0 overflow-hidden rounded bg-gray-950">
            {storyboardUrl ? (
              <img src={storyboardUrl} alt="首幀分鏡" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-gray-700">
                <ImageIcon className="h-4 w-4" />
              </div>
            )}
          </div>
          <div className="flex-1 flex flex-col gap-0.5">
            <div className="flex items-center justify-between">
              <span className="font-medium text-gray-300">首幀分鏡圖</span>
              <VersionTimeMachine
                projectName={projectName}
                resourceType="storyboards"
                resourceId={segmentId}
                onRestore={onRestoreStoryboard}
              />
            </div>
            <span className="text-[10px] text-gray-500">影片生成時將以此作為首幀預覽</span>
          </div>
        </div>
      )}

      {/* ---- Video ---- */}
      {(stage === undefined || stage === "video") && (
        <div className={`mx-auto w-full ${maxWClass}`}>
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Film className="h-3 w-3 text-gray-500" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">影片</span>
            </div>
            <VersionTimeMachine
              projectName={projectName}
              resourceType="videos"
              resourceId={segmentId}
              onRestore={onRestoreVideo}
            />
          </div>
          {videoUrl ? (
            <PreviewableVideoFrame src={videoUrl} poster={thumbnailUrl} alt={`${segmentId} 影片`}>
              <AspectFrame ratio={normalizedRatio}>
                <VideoPlayer src={videoUrl} poster={thumbnailUrl} />
              </AspectFrame>
            </PreviewableVideoFrame>
          ) : (
            <div className="flex items-center justify-center rounded-lg border border-dashed border-gray-700 bg-gray-800/30 py-4">
              <span className="text-xs text-gray-600">
                {assets?.storyboard_image ? "可生成影片" : "需先生成分鏡"}
              </span>
            </div>
          )}
          <div className="mt-2">
            <GenerateButton
              onClick={() => onGenerateVideo?.(segmentId)}
              loading={generatingVideo}
              label="生成影片"
              className="w-full justify-center"
              disabled={!assets?.storyboard_image}
            />
          </div>
        </div>
      )}
    </div>
  );
}
