import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useProjectsStore } from "@/stores/projects-store";
import { SegmentCard } from "./SegmentCard";
import { PreprocessingView } from "./PreprocessingView";
import { FinalVideoCard } from "./FinalVideoCard";
import { EpisodeActionsBar } from "./EpisodeActionsBar";
import { EpisodeSplitPanel } from "./EpisodeSplitPanel";
import { useScrollTarget } from "@/hooks/useScrollTarget";
import { useConfirm } from "@/hooks/useConfirm";
import { useCostStore } from "@/stores/cost-store";
import { resolveEpisodeContentMode } from "@/utils/content-mode";
import { formatCost, totalBreakdown } from "@/utils/cost-format";
import type {
  EpisodeScript,
  NarrationEpisodeScript,
  DramaEpisodeScript,
  NarrationSegment,
  DramaScene,
  ProjectData,
} from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Segment = NarrationSegment | DramaScene;
type SegmentUpdateExtras = Record<string, unknown>;

function getSegmentId(segment: Segment, mode: "narration" | "drama"): string {
  return mode === "narration"
    ? (segment as NarrationSegment).segment_id
    : (segment as DramaScene).scene_id;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TimelineCanvasProps {
  projectName: string;
  episode: number;
  episodeTitle?: string;
  hasDraft?: boolean;
  episodeScript: EpisodeScript | null;
  scriptFile?: string;
  projectData: ProjectData | null;
  onUpdatePrompt?: (
    segmentId: string,
    field: string,
    value: unknown,
    scriptFile?: string,
    extraUpdates?: SegmentUpdateExtras,
  ) => void;
  onGenerateStoryboard?: (segmentId: string, scriptFile?: string) => void;
  onGenerateVideo?: (segmentId: string, scriptFile?: string) => void;
  durationOptions?: number[];
  onRestoreStoryboard?: () => Promise<void> | void;
  onRestoreVideo?: () => Promise<void> | void;
  generatingStoryboardIds?: Set<string>;
  generatingVideoIds?: Set<string>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Main canvas container that renders a vertical list of SegmentCards for
 * the currently selected episode.
 *
 * Shows episode header (title, segment count, duration), followed by the
 * full timeline of segment cards with spacing.
 */
export function TimelineCanvas({
  projectName,
  episode,
  episodeTitle,
  hasDraft,
  episodeScript,
  scriptFile,
  projectData,
  durationOptions,
  onUpdatePrompt,
  onGenerateStoryboard,
  onGenerateVideo,
  onRestoreStoryboard,
  onRestoreVideo,
  generatingStoryboardIds,
  generatingVideoIds,
}: TimelineCanvasProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const contentMode = resolveEpisodeContentMode(episodeScript, projectData?.content_mode);
  const sourceFilesVersion = useAppStore((s) => s.sourceFilesVersion);
  const [sourceFiles, setSourceFiles] = useState<string[]>([]);

  const hasScript = Boolean(episodeScript);
  const showTabs = Boolean(hasDraft);
  const defaultTab = hasScript ? "timeline" : "preprocessing";
  const [activeTab, setActiveTab] = useState<"preprocessing" | "timeline">(defaultTab);

  // Auto-switch to timeline when script becomes available
  useEffect(() => {
    if (hasScript) setActiveTab("timeline");
  }, [hasScript]);

  useEffect(() => {
    if (!projectName || (projectData?.episodes?.length ?? 0) > 0) {
      setSourceFiles([]);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const result = await API.listFiles(projectName);
        const files = (result.files?.source ?? [])
          .map((file) => `source/${file.name}`)
          .filter((name) => name.endsWith(".txt"));
        if (!cancelled) setSourceFiles(files);
      } catch {
        if (!cancelled) setSourceFiles([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectName, projectData?.episodes?.length, sourceFilesVersion]);

  const refreshProject = useCallback(async () => {
    const result = await API.getProject(projectName);
    useProjectsStore.getState().setCurrentProject(
      projectName,
      result.project,
      result.scripts ?? {},
      result.asset_fingerprints,
    );
    useAppStore.getState().invalidateSourceFiles();
  }, [projectName]);

  const handleDeleteSegment = useCallback(
    async (segmentId: string) => {
      if (!scriptFile) return;
      const label = contentMode === "narration" ? "片段" : "場景";
      const ok = await confirm({
        message: `確定要刪除${label}「${segmentId}」？此操作無法復原。`,
        danger: true,
      });
      if (!ok) return;
      try {
        if (contentMode === "narration") {
          await API.deleteSegment(projectName, segmentId, scriptFile);
        } else {
          await API.deleteScene(projectName, segmentId, scriptFile);
        }
        await refreshProject();
        useAppStore.getState().pushToast(`已刪除${label}「${segmentId}」`, "success");
      } catch (err) {
        useAppStore
          .getState()
          .pushToast(`刪除失敗：${(err as Error).message}`, "error");
      }
    },
    [projectName, scriptFile, contentMode, refreshProject, confirm],
  );

  const handleResetScript = useCallback(async () => {
    if (!episodeScript) return;
    const confirmed = await confirm({
      message:
        "確定要清空這一集的劇本內容嗎？會清掉所有片段／場景與其分鏡、影片提示詞，回到空骨架（預處理草稿保留）。此操作無法復原。",
      danger: true,
    });
    if (!confirmed) return;

    try {
      await API.resetEpisodeScript(projectName, episodeScript.episode);
      await refreshProject();
      useAppStore.getState().pushToast("已清空這一集的劇本", "success");
      setActiveTab("preprocessing");
    } catch (err) {
      useAppStore
        .getState()
        .pushToast(`清空失敗：${(err as Error).message}`, "error");
    }
  }, [projectName, episodeScript, refreshProject, confirm]);

  const episodeCost = useCostStore((s) =>
    episodeScript ? s.getEpisodeCost(episodeScript.episode) : undefined,
  );
  const debouncedFetch = useCostStore((s) => s.debouncedFetch);

  useEffect(() => {
    if (!projectName) return;
    debouncedFetch(projectName);
  }, [projectName, episodeScript?.episode, debouncedFetch]);

  // Determine aspect ratio — use project config if available, otherwise defaults
  const aspectRatio =
    typeof projectData?.aspect_ratio === "string"
      ? projectData.aspect_ratio
      : projectData?.aspect_ratio?.storyboard ??
        (contentMode === "narration" ? "9:16" : "16:9");

  // Pick the correct array (segments for narration, scenes for drama)
  const segments = useMemo<Segment[]>(
    () =>
      !episodeScript || !projectData
        ? []
        : contentMode === "narration"
          ? ((episodeScript as NarrationEpisodeScript).segments ?? [])
          : ((episodeScript as DramaEpisodeScript).scenes ?? []),
    [contentMode, episodeScript, projectData],
  );
  const segmentIndexMap = useMemo(
    () =>
      new Map(
        segments.map((segment, index) => [getSegmentId(segment, contentMode), index]),
      ),
    [contentMode, segments],
  );
  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 200,
    overscan: 5,
    measureElement: (element) => element?.getBoundingClientRect().height ?? 200,
  });
  const prepareScrollTarget = useCallback(
    (target: { id: string }) => {
      const index = segmentIndexMap.get(target.id);
      if (index == null) {
        return false;
      }
      virtualizer.scrollToIndex(index, { align: "center" });
      return true;
    },
    [segmentIndexMap, virtualizer],
  );

  // Respond to agent-triggered scroll targets for segments
  useScrollTarget("segment", { prepareTarget: prepareScrollTarget });

  const updatePromptForScript = useMemo(
    () =>
      onUpdatePrompt
        ? (
            id: string,
            field: string,
            value: unknown,
            extraUpdates?: SegmentUpdateExtras,
          ) => onUpdatePrompt(id, field, value, scriptFile, extraUpdates)
        : undefined,
    [onUpdatePrompt, scriptFile],
  );
  const generateStoryboardForScript = useMemo(
    () =>
      onGenerateStoryboard
        ? (id: string) => onGenerateStoryboard(id, scriptFile)
        : undefined,
    [onGenerateStoryboard, scriptFile],
  );
  const generateVideoForScript = useMemo(
    () =>
      onGenerateVideo
        ? (id: string) => onGenerateVideo(id, scriptFile)
        : undefined,
    [onGenerateVideo, scriptFile],
  );

  // Empty state — no episode selected or no content at all
  if (!projectData || (!episodeScript && !hasDraft)) {
    if (projectData && (projectData.episodes?.length ?? 0) === 0) {
      return (
        <div className="h-full overflow-y-auto p-4">
          <EpisodeSplitPanel
            projectName={projectName}
            sourceFiles={sourceFiles.length > 0 ? sourceFiles : ["source/novel.txt"]}
            onSplitDone={refreshProject}
          />
        </div>
      );
    }

    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        請在左側選擇劇集
      </div>
    );
  }

  // Compute total duration from actual segments if available
  const totalDuration =
    episodeScript?.duration_seconds ??
    segments.reduce((sum, s) => sum + s.duration_seconds, 0);

  // Label depends on content mode
  const segmentLabel = contentMode === "narration" ? "個片段" : "個場景";
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <div className="p-4">
        {/* ---- Episode header ---- */}
        <div className="mb-4">
          <EpisodeTitleEditor
            projectName={projectName}
            episode={episodeScript?.episode ?? episode}
            title={episodeScript?.title ?? episodeTitle ?? ""}
          />
          {episodeScript && (
            <p className="text-xs text-gray-500">
              {segments.length} {segmentLabel} · 約 {totalDuration}s
            </p>
          )}
          {episodeCost && (
            <div className="mt-2 flex items-center gap-4 rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 text-xs tabular-nums">
              <span className="text-gray-600">預估</span>
              <span className="text-gray-500">分鏡 <span className="text-gray-300">{formatCost(episodeCost.totals.estimate.image)}</span></span>
              <span className="text-gray-500">影片 <span className="text-gray-300">{formatCost(episodeCost.totals.estimate.video)}</span></span>
              <span className="text-gray-500">總計 <span className="font-medium text-amber-400">{formatCost(totalBreakdown(episodeCost.totals.estimate))}</span></span>
              <span className="text-gray-700">|</span>
              <span className="text-gray-600">實際</span>
              <span className="text-gray-500">分鏡 <span className="text-gray-300">{formatCost(episodeCost.totals.actual.image)}</span></span>
              <span className="text-gray-500">影片 <span className="text-gray-300">{formatCost(episodeCost.totals.actual.video)}</span></span>
              <span className="text-gray-500">總計 <span className="font-medium text-emerald-400">{formatCost(totalBreakdown(episodeCost.totals.actual))}</span></span>
            </div>
          )}
          <EpisodeActionsBar
            projectName={projectName}
            episode={episodeScript?.episode ?? episode}
            scriptFile={scriptFile}
            hasScript={hasScript}
          />
        </div>

        {/* ---- Tab bar (only when draft exists) ---- */}
        {showTabs && (
          <div className="mb-4 flex gap-0 border-b border-gray-800">
            <button
              type="button"
              onClick={() => setActiveTab("preprocessing")}
              className={`border-b-2 px-4 py-2 text-sm transition-colors focus-ring rounded-t ${
                activeTab === "preprocessing"
                  ? "border-indigo-500 text-indigo-400 font-medium"
                  : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              預處理
            </button>
            <button
              type="button"
              onClick={() => hasScript && setActiveTab("timeline")}
              disabled={!hasScript}
              className={`border-b-2 px-4 py-2 text-sm transition-colors focus-ring rounded-t ${
                activeTab === "timeline"
                  ? "border-indigo-500 text-indigo-400 font-medium"
                  : !hasScript
                    ? "border-transparent text-gray-700 cursor-not-allowed"
                    : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              劇本時間線
            </button>
          </div>
        )}

        {/* ---- Tab content ---- */}
        {activeTab === "preprocessing" && hasDraft ? (
          <PreprocessingView
            projectName={projectName}
            episode={episode}
            contentMode={contentMode}
          />
        ) : episodeScript ? (
          <>
            <div className="mb-4 flex items-center gap-2">
              <AddSegmentButton
                projectName={projectName}
                episode={episodeScript.episode}
                contentMode={contentMode}
                onAdded={refreshProject}
              />
              <button
                type="button"
                onClick={() => void handleResetScript()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-sm text-red-300/80 transition-colors hover:border-red-400/60 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-4 w-4" />
                清空劇本
              </button>
            </div>
            {segments.length === 0 && (
              <p className="mb-4 text-sm text-gray-600">
                這一集還沒有{contentMode === "narration" ? "片段" : "場景"}，點上方按鈕新增。
              </p>
            )}
            <div
              className="relative"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualItems.map((virtualItem) => {
                const segment = segments[virtualItem.index];
                const segId = getSegmentId(segment, contentMode);
                return (
                  <div
                    id={`segment-${segId}`}
                    key={segId}
                    data-index={virtualItem.index}
                    ref={virtualizer.measureElement}
                    className="absolute left-0 top-0 w-full"
                    style={{
                      transform: `translateY(${virtualItem.start}px)`,
                      paddingBottom: virtualItem.index === segments.length - 1 ? 0 : 16,
                    }}
                  >
                    <SegmentCard
                      segment={segment}
                      contentMode={contentMode}
                      aspectRatio={aspectRatio}
                      characters={projectData.characters}
                      clues={projectData.clues}
                      projectName={projectName}
                      durationOptions={durationOptions}
                      onUpdatePrompt={updatePromptForScript}
                      onGenerateStoryboard={generateStoryboardForScript}
                      onGenerateVideo={generateVideoForScript}
                      onRestoreStoryboard={onRestoreStoryboard}
                      onRestoreVideo={onRestoreVideo}
                      onDelete={() => void handleDeleteSegment(segId)}
                      generatingStoryboard={generatingStoryboardIds?.has(segId) ?? false}
                      generatingVideo={generatingVideoIds?.has(segId) ?? false}
                    />
                  </div>
                );
              })}
            </div>
          </>
        ) : null}

        {/* Final composed video */}
        {activeTab === "timeline" && episodeScript && (
          <FinalVideoCard projectName={projectName} episode={episodeScript.episode} />
        )}

        {/* Bottom spacer for scroll comfort */}
        <div className="h-16" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddSegmentButton — 在劇本末尾新增一個空片段/場景
// ---------------------------------------------------------------------------

function AddSegmentButton({
  projectName,
  episode,
  contentMode,
  onAdded,
}: {
  projectName: string;
  episode: number;
  contentMode: "narration" | "drama";
  onAdded: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const label = contentMode === "narration" ? "新增片段" : "新增場景";

  const handleAdd = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (contentMode === "narration") {
        await API.addEpisodeSegment(projectName, episode);
      } else {
        await API.addEpisodeScene(projectName, episode);
      }
      await onAdded();
      useAppStore.getState().pushToast(`已${label}`, "success");
    } catch (err) {
      useAppStore.getState().pushToast(`${label}失敗：${(err as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleAdd()}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/40 px-3 py-1.5 text-sm text-indigo-300 transition-colors hover:border-indigo-400 hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Plus className="h-4 w-4" />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// EpisodeTitleEditor — inline-editable episode title with hover pencil icon
// ---------------------------------------------------------------------------

function EpisodeTitleEditor({
  projectName,
  episode,
  title,
}: {
  projectName: string;
  episode: number;
  title: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(title);
  }, [title]);

  const commit = async () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft(title);
      setEditing(false);
      return;
    }
    if (trimmed === title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await API.updateEpisode(projectName, episode, { title: trimmed });
      const res = await API.getProject(projectName);
      useProjectsStore.getState().setCurrentProject(
        projectName,
        res.project,
        res.scripts ?? {},
        res.asset_fingerprints,
      );
      useAppStore.getState().pushToast(`E${episode} 標題已更新`, "success");
    } catch (err) {
      useAppStore.getState().pushToast(`更新失敗：${(err as Error).message}`, "error");
      setDraft(title);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        type="text"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            setDraft(title);
            setEditing(false);
          }
        }}
        disabled={saving}
        className="w-full max-w-md rounded border border-indigo-500 bg-gray-800 px-2 py-0.5 text-lg font-semibold text-gray-100 focus:outline-none disabled:opacity-50"
        aria-label="劇集標題"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="group flex items-center gap-2 text-left"
      title="點擊編輯標題"
    >
      <h2 className="text-lg font-semibold text-gray-100">
        {title || "（未命名劇集）"}
      </h2>
      <Pencil className="h-3.5 w-3.5 text-gray-600 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
