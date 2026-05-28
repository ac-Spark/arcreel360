import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Settings } from "lucide-react";
import { API } from "@/api";
import { providersApi } from "@/api/providers";
import { Popover } from "@/components/ui/Popover";
import { ProviderModelSelect } from "@/components/ui/ProviderModelSelect";
import { formatCost } from "@/utils/cost-format";
import type { ProviderInfo } from "@/types";

interface SceneBackendPopoverProps {
  projectName: string;
  episode: number;
  sceneId: string;
  scriptFile: string;
  sceneImageBackend?: string | null;
  sceneVideoBackend?: string | null;
  onChanged?: (next: { image: string | null; video: string | null }) => void;
}

interface ModelOptions {
  image: string[];
  video: string[];
  providerNames: Record<string, string>;
}

const EMPTY_MODEL_OPTIONS: ModelOptions = { image: [], video: [], providerNames: {} };

function buildModelOptions(providers: ProviderInfo[]): ModelOptions {
  const image: string[] = [];
  const video: string[] = [];
  const providerNames: Record<string, string> = {};
  for (const provider of providers) {
    if (provider.status !== "ready") continue;
    providerNames[provider.id] = provider.display_name;
    for (const [modelId, info] of Object.entries(provider.models ?? {})) {
      const value = `${provider.id}/${modelId}`;
      if (info.media_type === "image") {
        image.push(value);
      } else if (info.media_type === "video") {
        video.push(value);
      }
    }
  }
  return { image, video, providerNames };
}

interface CostDiff {
  current: number;
  next: number;
  delta: number;
  currency: string;
}

type BackendPatch = { image_backend?: string | null; video_backend?: string | null };
type ScriptItemIdField = "segment_id" | "scene_id";
type ScriptItem = Partial<Record<ScriptItemIdField, unknown>>;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toBackendOverride(value: string): string | null {
  return value || null;
}

function buildChangedBackendPatch(
  imageDraft: string,
  currentImageBackend: string,
  videoDraft: string,
  currentVideoBackend: string,
): BackendPatch {
  const patch: BackendPatch = {};
  if (imageDraft !== currentImageBackend) {
    patch.image_backend = toBackendOverride(imageDraft);
  }
  if (videoDraft !== currentVideoBackend) {
    patch.video_backend = toBackendOverride(videoDraft);
  }
  return patch;
}

function buildEpisodeBackendPatch(imageDraft: string, videoDraft: string): Required<BackendPatch> {
  return {
    image_backend: toBackendOverride(imageDraft),
    video_backend: toBackendOverride(videoDraft),
  };
}

function getScriptItems(script: unknown): { items: ScriptItem[]; idField: ScriptItemIdField } {
  const parsed = script as {
    content_mode?: string;
    segments?: ScriptItem[];
    scenes?: ScriptItem[];
  };

  if (parsed.content_mode === "narration") {
    return { items: parsed.segments ?? [], idField: "segment_id" };
  }
  return { items: parsed.scenes ?? [], idField: "scene_id" };
}

function getCostDeltaPresentation(delta: number): { sign: string; className: string } {
  if (delta > 0) {
    return { sign: "+", className: "text-red-400" };
  }
  if (delta < 0) {
    return { sign: "-", className: "text-green-400" };
  }
  return { sign: "±", className: "text-gray-500" };
}

export function SceneBackendPopover({
  projectName,
  episode,
  sceneId,
  scriptFile,
  sceneImageBackend,
  sceneVideoBackend,
  onChanged,
}: SceneBackendPopoverProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const currentImageBackend = sceneImageBackend ?? "";
  const currentVideoBackend = sceneVideoBackend ?? "";
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [imageDraft, setImageDraft] = useState<string>(currentImageBackend);
  const [videoDraft, setVideoDraft] = useState<string>(currentVideoBackend);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cost, setCost] = useState<{ image: CostDiff; video: CostDiff } | null>(null);

  useEffect(() => {
    setImageDraft(currentImageBackend);
    setVideoDraft(currentVideoBackend);
  }, [currentImageBackend, currentVideoBackend]);

  useEffect(() => {
    if (!open || providers !== null) return;
    let cancelled = false;
    providersApi
      .getProviders()
      .then((res) => {
        if (!cancelled) setProviders(res.providers);
      })
      .catch((error) => {
        if (!cancelled) setError(getErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, providers]);

  const options = useMemo(
    () => (providers ? buildModelOptions(providers) : EMPTY_MODEL_OPTIONS),
    [providers],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    API.estimateSceneCost({
      project_name: projectName,
      script_file: scriptFile,
      scene_id: sceneId,
      image_backend: toBackendOverride(imageDraft),
      video_backend: toBackendOverride(videoDraft),
    })
      .then((res) => {
        if (!cancelled) setCost({ image: res.image, video: res.video });
      })
      .catch(() => {
        if (!cancelled) setCost(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectName, scriptFile, sceneId, imageDraft, videoDraft]);

  const dirty = imageDraft !== currentImageBackend || videoDraft !== currentVideoBackend;

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const patch = buildChangedBackendPatch(
        imageDraft,
        currentImageBackend,
        videoDraft,
        currentVideoBackend,
      );
      const res = await API.updateSceneBackend(projectName, episode, sceneId, scriptFile, patch);
      onChanged?.({ image: res.image_backend, video: res.video_backend });
      setOpen(false);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [
    imageDraft,
    videoDraft,
    currentImageBackend,
    currentVideoBackend,
    projectName,
    episode,
    sceneId,
    scriptFile,
    onChanged,
  ]);

  const handleApplyToEpisode = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const script = await API.getScript(projectName, scriptFile);
      const { items, idField } = getScriptItems(script);
      const targets = items
        .map((item) => String(item[idField] ?? ""))
        .filter((id) => id && id !== sceneId);
      const patch = buildEpisodeBackendPatch(imageDraft, videoDraft);
      await Promise.all(
        targets.map((id) => API.updateSceneBackend(projectName, episode, id, scriptFile, patch)),
      );
      onChanged?.({ image: patch.image_backend, video: patch.video_backend });
      setOpen(false);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [
    projectName,
    episode,
    sceneId,
    scriptFile,
    imageDraft,
    videoDraft,
    onChanged,
  ]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="設定本分鏡的模型"
        aria-label="分鏡模型設定"
        className="rounded p-1 text-gray-600 transition-colors hover:bg-blue-500/10 hover:text-blue-300"
      >
        <Settings className="h-3.5 w-3.5" />
      </button>
      <Popover
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        width="w-80"
        align="end"
      >
        <div className="space-y-3 p-3 text-sm">
          <div className="font-medium text-gray-200">分鏡模型設定</div>

          <div className="space-y-1">
            <label className="text-xs text-gray-400">🖼 圖片後端</label>
            <ProviderModelSelect
              value={imageDraft}
              options={options.image}
              providerNames={options.providerNames}
              onChange={setImageDraft}
              allowDefault
              defaultLabel="沿用專案預設"
              aria-label="選擇圖片後端"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-gray-400">🎬 影片後端</label>
            <ProviderModelSelect
              value={videoDraft}
              options={options.video}
              providerNames={options.providerNames}
              onChange={setVideoDraft}
              allowDefault
              defaultLabel="沿用專案預設"
              aria-label="選擇影片後端"
            />
          </div>

          {cost && (
            <div className="rounded bg-gray-800/60 px-2 py-1.5 text-[11px] text-gray-400">
              <div className="mb-0.5 text-gray-500">預估費用（本場景）</div>
              <CostRow label="圖片" diff={cost.image} />
              <CostRow label="影片" diff={cost.video} />
            </div>
          )}

          <div className="text-[11px] text-amber-400/80">
            ⚠️ 混用模型可能造成風格不一致
          </div>

          {error && <div className="text-[11px] text-red-400">{error}</div>}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void handleSave()}
              className="flex-1 rounded bg-blue-600 px-2 py-1 text-xs text-white disabled:cursor-not-allowed disabled:bg-gray-700"
            >
              {saving ? "儲存中…" : "套用本分鏡"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleApplyToEpisode()}
              title="將本分鏡的圖片/影片後端設定，複製到同集所有其他分鏡"
              className="flex-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              套用至本集
            </button>
          </div>
        </div>
      </Popover>
    </>
  );
}

function CostRow({ label, diff }: { label: string; diff: CostDiff }) {
  const breakdownCur = { [diff.currency]: diff.current };
  const breakdownNext = { [diff.currency]: diff.next };
  const breakdownDelta = { [diff.currency]: Math.abs(diff.delta) };
  const { sign, className } = getCostDeltaPresentation(diff.delta);
  return (
    <div className="flex items-center justify-between tabular-nums">
      <span>
        {label}：{formatCost(breakdownCur)} → {formatCost(breakdownNext)}
      </span>
      <span className={className}>
        ({sign}
        {formatCost(breakdownDelta)})
      </span>
    </div>
  );
}
