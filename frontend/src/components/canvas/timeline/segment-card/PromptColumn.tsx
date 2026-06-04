import { useEffect, useMemo, useRef, useState } from "react";
import { ImageIcon, Film } from "lucide-react";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { ImagePromptEditor } from "../ImagePromptEditor";
import { VideoPromptEditor } from "../VideoPromptEditor";
import type { ImagePrompt, VideoPrompt } from "@/types";
import type {
  Segment,
  SegmentMentionDrafts,
  SegmentMentionDraftKey,
  PromptMentionDraftKey,
  SegmentUpdateExtras,
  SegmentUpdateHandler,
} from "./types";
import {
  isStructuredImagePromptValue,
  isStructuredVideoPromptValue,
  mergePromptPatch,
  type SegmentMentionContext,
} from "./helpers";

interface PromptColumnProps {
  segment: Segment;
  segmentId: string;
  onUpdatePrompt?: SegmentUpdateHandler;
  speakerOptions?: string[];
  mentionContext: SegmentMentionContext;
  onMentionDraftChange: (key: SegmentMentionDraftKey, value: unknown) => void;
  buildMentionUpdatesForDraft: (
    patch: Partial<SegmentMentionDrafts>,
  ) => SegmentUpdateExtras | undefined;
  stage?: "storyboard" | "video";
}

export function PromptColumn({
  segment,
  segmentId,
  onUpdatePrompt,
  speakerOptions,
  mentionContext,
  onMentionDraftChange,
  buildMentionUpdatesForDraft,
  stage,
}: PromptColumnProps) {
  const { image_prompt, video_prompt } = segment;
  const buildPromptMentionUpdates = (
    key: PromptMentionDraftKey,
    value: unknown,
  ) => buildMentionUpdatesForDraft({ [key]: value });

  const isStructuredImage = isStructuredImagePromptValue(image_prompt);
  const isStructuredVideo = isStructuredVideoPromptValue(video_prompt);

  // ---- String fallback state (only used when prompts are plain strings) ----
  const promptToStr = (p: unknown, key: string): string => {
    if (typeof p === "string") return p;
    if (typeof p === "object" && p !== null) {
      const val = (p as Record<string, unknown>)[key];
      if (typeof val === "string") return val;
    }
    return "";
  };

  const [imgText, setImgText] = useState(() => promptToStr(image_prompt, "scene"));
  const [vidText, setVidText] = useState(() => promptToStr(video_prompt, "action"));
  const [imgDraft, setImgDraft] = useState<ImagePrompt | null>(() =>
    isStructuredImage ? (image_prompt as ImagePrompt) : null
  );
  const [vidDraft, setVidDraft] = useState<VideoPrompt | null>(() =>
    isStructuredVideo ? (video_prompt as VideoPrompt) : null
  );

  const isImagePromptEmpty = useMemo(() => {
    if (isStructuredImage) {
      return !image_prompt || !(image_prompt as ImagePrompt).scene?.trim();
    }
    return !imgText.trim();
  }, [isStructuredImage, image_prompt, imgText]);

  const isVideoPromptEmpty = useMemo(() => {
    if (isStructuredVideo) {
      return !video_prompt || !(video_prompt as VideoPrompt).action?.trim();
    }
    return !vidText.trim();
  }, [isStructuredVideo, video_prompt, vidText]);

  const prevSegmentIdRef = useRef(segmentId);

  useEffect(() => {
    if (prevSegmentIdRef.current === segmentId) {
      return;
    }

    prevSegmentIdRef.current = segmentId;
    setImgText(promptToStr(image_prompt, "scene"));
    setVidText(promptToStr(video_prompt, "action"));
    setImgDraft(isStructuredImage ? (image_prompt as ImagePrompt) : null);
    setVidDraft(isStructuredVideo ? (video_prompt as VideoPrompt) : null);
  }, [
    segmentId,
    image_prompt,
    video_prompt,
    isStructuredImage,
    isStructuredVideo,
  ]);

  useEffect(() => {
    if (!isStructuredImage) {
      setImgDraft(null);
      setImgText(promptToStr(image_prompt, "scene"));
    }
  }, [image_prompt, isStructuredImage]);

  useEffect(() => {
    if (!isStructuredVideo) {
      setVidDraft(null);
      setVidText(promptToStr(video_prompt, "action"));
    }
  }, [video_prompt, isStructuredVideo]);

  // ---- Firing helpers ----
  const fireStructuredImage = (patch: Partial<ImagePrompt>) => {
    setImgDraft((prev) => {
      const base = prev ?? (isStructuredImage ? image_prompt : null);
      if (!base) {
        return prev;
      }
      const merged = mergePromptPatch(
        base as unknown as Record<string, unknown>,
        patch as Record<string, unknown>
      ) as unknown as ImagePrompt;
      onMentionDraftChange("imagePrompt", merged);
      onUpdatePrompt?.(
        segmentId,
        "image_prompt",
        merged,
        buildPromptMentionUpdates("imagePrompt", merged),
      );
      return merged;
    });
  };

  const fireStructuredVideo = (patch: Partial<VideoPrompt>) => {
    setVidDraft((prev) => {
      const base = prev ?? (isStructuredVideo ? video_prompt : null);
      if (!base) {
        return prev;
      }
      const merged = mergePromptPatch(
        base as unknown as Record<string, unknown>,
        patch as Record<string, unknown>
      ) as unknown as VideoPrompt;
      onMentionDraftChange("videoPrompt", merged);
      onUpdatePrompt?.(
        segmentId,
        "video_prompt",
        merged,
        buildPromptMentionUpdates("videoPrompt", merged),
      );
      return merged;
    });
  };

  const fireString = (
    field: "image_prompt" | "video_prompt",
    key: PromptMentionDraftKey,
    value: string,
  ) => {
    onMentionDraftChange(key, value);
    onUpdatePrompt?.(segmentId, field, value, buildPromptMentionUpdates(key, value));
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
        提示詞
      </span>

      {/* ---- Image Prompt ---- */}
      {(stage === undefined || stage === "storyboard") && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <ImageIcon className="h-3.5 w-3.5 text-gray-500" />
            <span className="text-[11px] font-semibold text-gray-400">
              Image Prompt
            </span>
          </div>

          {isStructuredImage && imgDraft ? (
            <ImagePromptEditor
              prompt={imgDraft}
              onUpdate={fireStructuredImage}
              entities={mentionContext.entities}
              linkedNames={mentionContext.currentNames}
            />
          ) : (
            <AutoTextarea
              value={imgText}
              onChange={(v) => {
                setImgText(v);
                fireString("image_prompt", "imagePrompt", v);
              }}
              placeholder="分鏡圖描述..."
              entities={mentionContext.entities}
              linkedNames={mentionContext.currentNames}
            />
          )}
          {isImagePromptEmpty && (
            <span className="text-[10px] text-red-400 font-medium">⚠️ 描述為空，請輸入分鏡圖描述以避免生成失敗</span>
          )}
        </div>
      )}

      {/* ---- Video Prompt ---- */}
      {(stage === undefined || stage === "video") && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <Film className="h-3.5 w-3.5 text-gray-500" />
            <span className="text-[11px] font-semibold text-gray-400">
              Video Prompt
            </span>
          </div>

          {isStructuredVideo && vidDraft ? (
            <VideoPromptEditor
              prompt={vidDraft}
              onUpdate={fireStructuredVideo}
              speakerOptions={speakerOptions}
              entities={mentionContext.entities}
              linkedNames={mentionContext.currentNames}
            />
          ) : (
            <AutoTextarea
              value={vidText}
              onChange={(v) => {
                setVidText(v);
                fireString("video_prompt", "videoPrompt", v);
              }}
              placeholder="影片動作描述..."
              entities={mentionContext.entities}
              linkedNames={mentionContext.currentNames}
            />
          )}
          {isVideoPromptEmpty && (
            <span className="text-[10px] text-red-400 font-medium">⚠️ 描述為空，請輸入影片動作描述以避免生成失敗</span>
          )}
        </div>
      )}
    </div>
  );
}
