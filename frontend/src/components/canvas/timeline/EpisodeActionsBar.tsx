import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Film, Image as ImageIcon, RotateCcw, Scissors, Wand2 } from "lucide-react";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useProjectsStore } from "@/stores/projects-store";
import { useConfirm } from "@/hooks/useConfirm";
import type { ProjectOverview } from "@/types/project";
import { UI_LAYERS } from "@/utils/ui-layers";
import {
  RefsPicker,
  defaultRefsValue,
  hasCustomRefs,
  type RefsCatalog,
  type RefsValue,
} from "./RefsPicker";

interface EpisodeActionsBarProps {
  projectName: string;
  episode: number;
  scriptFile?: string;
  hasScript: boolean;
  activeTab?: "preprocessing" | "timeline";
}

type Busy =
  | null
  | "preprocess"
  | "script"
  | "storyboards"
  | "videos"
  | "compose";

type BatchKind = "storyboards" | "videos";

type SourceFile = { name: string; size: number; url?: string };

const SOURCE_TEXT_SUFFIXES = [".txt", ".md", ".text"];
const OVERVIEW_FIELDS = ["synopsis", "genre", "theme", "world_setting"] as const;
const NUM_SEGMENTS_STORAGE_PREFIX = "arcreel:num_segments";

function isSourceTextFile(file: SourceFile) {
  const lower = file.name.toLowerCase();
  return file.name !== "_remaining.txt" && SOURCE_TEXT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function hasProjectOverview(overview: ProjectOverview | undefined): boolean {
  return !!overview && OVERVIEW_FIELDS.some((field) => ((overview[field] ?? "").trim().length > 0));
}

function numSegmentsStorageKey(projectName: string, episode: number): string {
  return `${NUM_SEGMENTS_STORAGE_PREFIX}:${projectName}:${episode}`;
}

function readStoredNumSegments(storageKey: string): number | undefined {
  const saved = localStorage.getItem(storageKey);
  return saved ? parseInt(saved, 10) : undefined;
}

function persistNumSegments(storageKey: string, value: number | undefined): void {
  if (value !== undefined && !Number.isNaN(value)) {
    localStorage.setItem(storageKey, value.toString());
    return;
  }
  localStorage.removeItem(storageKey);
}

/**
 * 將上次保留的 refs 用最新 catalog 修剪一遍：
 * - overview 若 catalog.hasOverview=false → 強制取消勾選
 * - characters/clues/scenes：
 *   - catalog 該群為空 → null（沒有可選項目）
 *   - 上次為 null（全帶）→ 維持 null
 *   - 上次為具體清單 → 過濾已不存在的 key,保留 [] 與部分清單語意（[] = 全不勾,非空陣列 = 部分勾）
 *   - 若 catalog 變化導致 valid.length === all.length → 收斂為 null（與 normalizeGroup 一致）
 */
function pruneRefsAgainstCatalog(refs: RefsValue, catalog: RefsCatalog): RefsValue {
  const pruneGroup = (
    value: string[] | null,
    all: string[],
  ): string[] | null => {
    if (all.length === 0) return null;
    if (value === null) return null;
    const valid = value.filter((name) => all.includes(name));
    if (valid.length === all.length) return null;
    return valid;
  };

  return {
    overview: catalog.hasOverview ? refs.overview : false,
    style: refs.style,
    characters: pruneGroup(refs.characters, catalog.characters),
    clues: pruneGroup(refs.clues, catalog.clues),
    scenes: pruneGroup(refs.scenes, catalog.scenes),
  };
}

function preprocessConfirmMessage(hasScript: boolean, selectedCount: number): string {
  if (selectedCount > 0) {
    return hasScript
      ? `重新拆段會覆蓋目前的片段拆分結果。確定要使用選取的 ${selectedCount} 個原文檔案重新拆段？`
      : `確定要使用選取的 ${selectedCount} 個原文檔案進行拆段？`;
  }
  return hasScript
    ? "重新拆段會覆蓋目前的片段拆分結果。確定要自動均分原文進行重新拆段？"
    : "拆段會把這集原文切成片段。確定要自動均分原文進行拆段？";
}

/**
 * Episode-level batch actions: preprocess / regenerate script /
 * batch regenerate storyboards / videos / compose final video.
 */
export function EpisodeActionsBar({
  projectName,
  episode,
  scriptFile,
  hasScript,
  activeTab = "timeline",
}: EpisodeActionsBarProps) {
  const [busy, setBusy] = useState<Busy>(null);
  const [batchDialog, setBatchDialog] = useState<BatchKind | null>(null);
  const confirm = useConfirm();

  const toast = (msg: string, kind: "success" | "error" | "info" = "info") =>
    useAppStore.getState().pushToast(msg, kind);
  const preprocessLabel = hasScript ? "重新拆段" : "拆段";
  const scriptLabel = hasScript ? "重新生成劇本" : "生成劇本";

  const run = async (
    label: Busy,
    description: string,
    fn: () => Promise<string>,
  ) => {
    if (busy) return;
    setBusy(label);
    try {
      const result = await fn();
      toast(`${description}：${result}`, "success");
    } catch (err) {
      toast(`${description}失敗：${(err as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [sources, setSources] = useState<{ name: string; size: number }[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [numSegments, setNumSegments] = useState<number | undefined>(undefined);
  const numSegmentsKey = numSegmentsStorageKey(projectName, episode);

  useEffect(() => {
    setNumSegments(readStoredNumSegments(numSegmentsKey));
  }, [numSegmentsKey]);

  // 拆段時可勾選的「參考來源」清單,來自當前 project。
  const currentProjectData = useProjectsStore((s) => s.currentProjectData);
  const refsCatalog = useMemo<RefsCatalog>(() => {
    const p = currentProjectData;
    return {
      hasOverview: hasProjectOverview(p?.overview),
      characters: p?.characters ? Object.keys(p.characters) : [],
      clues: p?.clues ? Object.keys(p.clues) : [],
      scenes: p?.scenes ? Object.keys(p.scenes) : [],
    };
  }, [currentProjectData]);
  const [refs, setRefs] = useState<RefsValue>(() => defaultRefsValue(refsCatalog));
  // 首次掛載時 currentProjectData 可能還沒載入,refsCatalog 為空 → defaultRefsValue 算出的預設不準。
  // 用 ref 紀錄是否已用「真實 catalog」初始化過,首次開啟下拉時補一次預設。
  const refsInitialized = useRef(false);
  // 開啟下拉時保留上次選擇,只修剪已不存在的項目(避免狀態與 catalog 失同步)。
  // 首次開啟仍會用最新 catalog 重算預設,確保新角色/道具/場景自動帶入。
  const openDropdown = () => {
    if (!refsInitialized.current) {
      setRefs(defaultRefsValue(refsCatalog));
      refsInitialized.current = true;
    } else {
      setRefs((prev) => pruneRefsAgainstCatalog(prev, refsCatalog));
    }
    void fetchSources();
    setDropdownOpen(true);
  };
  const refsDirty = hasCustomRefs(refs, refsCatalog);

  const fetchSources = async () => {
    setLoadingSources(true);
    try {
      const res = await API.listFiles(projectName);
      const sourceFiles = ((res.files.source || []) as SourceFile[]).filter(isSourceTextFile);
      setSources(sourceFiles);
      // 修剪掉已不存在的舊選項,保留仍存在的勾選
      const validNames = new Set(sourceFiles.map((f) => f.name));
      setSelectedSources((prev) => prev.filter((name) => validNames.has(name)));
    } catch (err) {
      toast(`取得原文列表失敗：${(err as Error).message}`, "error");
    } finally {
      setLoadingSources(false);
    }
  };

  const toggleSourceSelection = (name: string) => {
    setSelectedSources((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
    );
  };

  const updateNumSegments = (value: string) => {
    const parsed = value ? parseInt(value, 10) : undefined;
    setNumSegments(parsed);
    persistNumSegments(numSegmentsKey, parsed);
  };

  const handleMultiSourceConfirm = async () => {
    setDropdownOpen(false);
    const hasSelectedSources = selectedSources.length > 0;
    const sourceStr = hasSelectedSources ? selectedSources.map((name) => `source/${name}`).join(",") : undefined;
    if (await confirm({ message: preprocessConfirmMessage(hasScript, selectedSources.length) })) {
      void handlePreprocess(sourceStr);
    }
  };

  const handlePreprocess = (source?: string) =>
    run("preprocess", preprocessLabel, async () => {
      const res = await API.preprocessEpisode(
        projectName,
        episode,
        source,
        refsDirty ? refs : undefined,
        numSegments,
      );
      useAppStore.getState().invalidateEntities([`draft:episode_${episode}_step1`]);
      return res.step1_path;
    });

  const handleScript = () =>
    run("script", scriptLabel, async () => {
      const res = await API.generateEpisodeScript(projectName, episode);
      return `${res.script_file}（${res.segments_count} 段）`;
    });

  const handleBatchStoryboards = (force: boolean) =>
    run("storyboards", force ? "強制重生分鏡" : "批次生成分鏡", async () => {
      if (!scriptFile) throw new Error("找不到劇本檔");
      const res = await API.batchGenerateStoryboards(projectName, {
        script_file: scriptFile,
        force,
      });
      return `已入隊 ${res.enqueued.length} 項，略過 ${res.skipped.length} 項`;
    });

  const handleBatchVideos = (force: boolean) =>
    run("videos", force ? "強制重生影片" : "批次生成影片", async () => {
      if (!scriptFile) throw new Error("找不到劇本檔");
      const res = await API.batchGenerateVideos(projectName, {
        script_file: scriptFile,
        force,
      });
      return `已入隊 ${res.enqueued.length} 項，略過 ${res.skipped.length} 項`;
    });

  const runBatchFromDialog = (kind: BatchKind, force: boolean) => {
    setBatchDialog(null);
    if (kind === "storyboards") {
      void handleBatchStoryboards(force);
      return;
    }
    void handleBatchVideos(force);
  };

  const handleCompose = () =>
    run("compose", "合成成片", async () => {
      const res = await API.composeEpisode(projectName, episode);
      return `${res.output_path}（${res.duration_seconds.toFixed(1)}s）`;
    });

  const confirmBtnText = selectedSources.length > 0
    ? `確定${preprocessLabel} (${selectedSources.length})`
    : `確定${preprocessLabel} (自動均分)`;

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {activeTab === "preprocessing" ? (
          <div className="relative">
            <ActionButton
              icon={<Scissors className="h-3.5 w-3.5" />}
              label={`${preprocessLabel} ▾`}
              loading={busy === "preprocess"}
              disabled={busy !== null}
              onClick={() => {
                if (!dropdownOpen) {
                  openDropdown();
                } else {
                  setDropdownOpen(false);
                }
              }}
              tone="neutral"
            />

            {dropdownOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
                <div className="absolute left-0 z-50 mt-1 min-w-[12rem] w-64 rounded-lg border border-gray-800 bg-gray-950 p-1.5 shadow-2xl">
                  <div className="px-2.5 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-gray-500">
                    選擇 source 檔案
                  </div>
                  <div className="px-2.5 pb-1 text-[0.625rem] text-gray-500 normal-case leading-snug">
                    不勾選則自動按集數均分整本原文
                  </div>
                  <div className="my-1 h-px bg-gray-800" />
                  {loadingSources ? (
                    <div className="flex items-center justify-center py-4 text-xs text-gray-400">
                      <span className="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border border-gray-600 border-t-transparent" />
                      載入中...
                    </div>
                  ) : sources.length === 0 ? (
                    <div className="px-2.5 py-3 text-center text-xs text-gray-500">
                      source/ 目錄下無可用文字檔
                    </div>
                  ) : (
                    <>
                      <div className="max-h-60 overflow-y-auto">
                        {sources.map((file) => {
                          const isSelected = selectedSources.includes(file.name);
                          return (
                            <button
                              key={file.name}
                              type="button"
                              onClick={() => toggleSourceSelection(file.name)}
                              className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs text-gray-300 transition-colors hover:bg-gray-800 hover:text-white"
                            >
                              <div className="flex items-center gap-2 truncate">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  readOnly
                                  className="h-3.5 w-3.5 rounded border-gray-700 bg-gray-900 text-indigo-600 focus:ring-0 focus:ring-offset-0"
                                />
                                <span className="truncate font-mono">{file.name}</span>
                              </div>
                              <span className="shrink-0 ml-2 text-[0.625rem] text-gray-500">
                                {(file.size / 1024).toFixed(1)} KB
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <div className="my-1.5 h-px bg-gray-800" />
                      <RefsPicker
                        catalog={refsCatalog}
                        value={refs}
                        onChange={setRefs}
                      />
                      <div className="my-1.5 h-px bg-gray-800" />
                      <div className="px-2.5 py-1">
                        <label
                          title="留空 = LLM 自動判斷"
                          className="block text-[0.6875rem] font-semibold uppercase tracking-wider text-gray-500 mb-1 cursor-help"
                        >
                          指定生成段數 / 場景數
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          placeholder="預設自動控制"
                          value={numSegments ?? ""}
                          onChange={(e) => updateNumSegments(e.target.value)}
                          className="w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300 placeholder-gray-600 outline-none focus:border-indigo-500 focus:ring-0"
                        />
                      </div>
                      <div className="my-1.5 h-px bg-gray-800" />
                      <div className="p-1">
                        <button
                          type="button"
                          onClick={() => void handleMultiSourceConfirm()}
                          className="flex w-full items-center justify-center rounded-md bg-indigo-600 px-3 py-1.5 text-center text-xs font-medium text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {confirmBtnText}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            <ActionButton
              icon={<Wand2 className="h-3.5 w-3.5" />}
              label={scriptLabel}
              loading={busy === "script"}
              disabled={busy !== null}
              onClick={async () => {
                const message = hasScript
                  ? "重新生成劇本會覆寫現有劇本。確定？"
                  : "生成劇本會根據拆段結果產生劇本。確定？";
                if (await confirm({ message })) void handleScript();
              }}
              tone="neutral"
            />

            <Divider />

            <ActionButton
              icon={<ImageIcon className="h-3.5 w-3.5" />}
              label="批次生成分鏡"
              loading={busy === "storyboards"}
              disabled={!hasScript || !scriptFile || busy !== null}
              onClick={() => setBatchDialog("storyboards")}
              tone="primary"
            />

            <Divider />

            <ActionButton
              icon={<Film className="h-3.5 w-3.5" />}
              label="批次生成影片"
              loading={busy === "videos"}
              disabled={!hasScript || !scriptFile || busy !== null}
              onClick={() => setBatchDialog("videos")}
              tone="primary"
            />

            <Divider />

            <ActionButton
              icon={<FileText className="h-3.5 w-3.5" />}
              label="合成成片"
              loading={busy === "compose"}
              disabled={!hasScript || busy !== null}
              onClick={async () => {
                if (await confirm({ message: "確定要合成成片嗎？（此操作會覆寫之前的成片）" })) {
                  void handleCompose();
                }
              }}
              tone="success"
            />
          </>
        )}
      </div>

      {batchDialog && (
        <BatchGenerationDialog
          kind={batchDialog}
          onSelect={(force) => runBatchFromDialog(batchDialog, force)}
          onCancel={() => setBatchDialog(null)}
        />
      )}
    </>
  );
}

function BatchGenerationDialog({
  kind,
  onSelect,
  onCancel,
}: {
  kind: BatchKind;
  onSelect: (force: boolean) => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onCancel]);

  const config =
    kind === "storyboards"
      ? {
          title: "批次生成分鏡",
          missingLabel: "只生成缺少的分鏡",
          forceLabel: "全部重生分鏡",
        }
      : {
          title: "批次生成影片",
          missingLabel: "只生成缺少的影片",
          forceLabel: "全部重生影片",
        };
  const headingId = `batch-generation-${kind}-title`;

  return (
    <div
      role="presentation"
      onClick={onCancel}
      className={`fixed inset-0 ${UI_LAYERS.modal} flex items-center justify-center bg-black/65 px-4`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="w-full max-w-sm rounded-2xl border border-gray-800 bg-gray-900 p-5 shadow-2xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={headingId} className="text-base font-semibold text-gray-100">
            {config.title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-400 transition-colors hover:border-gray-500 hover:text-gray-100"
          >
            取消
          </button>
        </div>

        <div className="grid gap-2">
          <button
            type="button"
            onClick={() => onSelect(false)}
            className="flex items-center gap-3 rounded-xl border border-indigo-500/40 bg-indigo-500/10 px-3 py-3 text-left text-sm text-indigo-100 transition-colors hover:border-indigo-400 hover:bg-indigo-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
          >
            <ImageIcon className="h-4 w-4 shrink-0 text-indigo-300" />
            <span>{config.missingLabel}</span>
          </button>
          <button
            type="button"
            onClick={() => onSelect(true)}
            className="flex items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-left text-sm text-amber-100 transition-colors hover:border-amber-400 hover:bg-amber-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60"
          >
            <RotateCcw className="h-4 w-4 shrink-0 text-amber-300" />
            <span>{config.forceLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function Divider() {
  return <span className="h-4 w-px bg-gray-800" aria-hidden />;
}

function ActionButton({
  icon,
  label,
  title,
  onClick,
  loading,
  disabled,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
  tone: "neutral" | "primary" | "warning" | "success";
}) {
  const toneClass = {
    neutral: "border-gray-700 text-gray-300 hover:border-gray-500 hover:text-gray-100",
    primary: "border-indigo-500/40 text-indigo-300 hover:border-indigo-400 hover:bg-indigo-500/10",
    warning: "border-amber-600/40 text-amber-400 hover:border-amber-500 hover:bg-amber-500/10",
    success: "border-emerald-500/40 text-emerald-300 hover:border-emerald-400 hover:bg-emerald-500/10",
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 ${toneClass}`}
    >
      {loading ? (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
      ) : (
        icon
      )}
      <span>{label}</span>
    </button>
  );
}
