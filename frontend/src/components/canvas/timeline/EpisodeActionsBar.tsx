import { useState } from "react";
import { ChevronDown, FileText, Film, Image as ImageIcon, RotateCcw, Scissors, Wand2 } from "lucide-react";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useConfirm } from "@/hooks/useConfirm";

interface EpisodeActionsBarProps {
  projectName: string;
  episode: number;
  scriptFile?: string;
  hasScript: boolean;
}

type Busy =
  | null
  | "preprocess"
  | "script"
  | "storyboards"
  | "videos"
  | "compose";

type SourceFile = { name: string; size: number; url?: string };

const SOURCE_TEXT_SUFFIXES = [".txt", ".md", ".text"];

function isSourceTextFile(file: SourceFile) {
  const lower = file.name.toLowerCase();
  return file.name !== "_remaining.txt" && SOURCE_TEXT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
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
}: EpisodeActionsBarProps) {
  const [busy, setBusy] = useState<Busy>(null);
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

  const fetchSources = async () => {
    setLoadingSources(true);
    try {
      const res = await API.listFiles(projectName);
      const sourceFiles = ((res.files.source || []) as SourceFile[]).filter(isSourceTextFile);
      setSources(sourceFiles);
    } catch (err) {
      toast(`取得原文列表失敗：${(err as Error).message}`, "error");
    } finally {
      setLoadingSources(false);
    }
  };

  const handleSourceSelect = async (sourceName: string) => {
    setDropdownOpen(false);
    const message = hasScript
      ? `重新拆段會覆蓋目前的片段拆分結果。確定要使用原文「${sourceName}」重新拆段？`
      : `確定要使用原文「${sourceName}」進行拆段？`;
    if (await confirm({ message })) {
      void handlePreprocess(sourceName);
    }
  };

  const handlePreprocess = (source?: string) =>
    run("preprocess", preprocessLabel, async () => {
      const res = await API.preprocessEpisode(projectName, episode, source);
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

  const handleCompose = () =>
    run("compose", "合成成片", async () => {
      const res = await API.composeEpisode(projectName, episode);
      return `${res.output_path}（${res.duration_seconds.toFixed(1)}s）`;
    });

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <ActionButton
        icon={<Scissors className="h-3.5 w-3.5" />}
        label={preprocessLabel}
        loading={busy === "preprocess"}
        disabled={busy !== null}
        onClick={async () => {
          const message = hasScript
            ? "重新拆段會覆蓋目前的片段拆分結果。確定？"
            : "拆段會把這集原文切成片段。確定？";
          if (await confirm({ message })) void handlePreprocess();
        }}
        tone="neutral"
      />

      <div className="relative">
        <ActionButton
          icon={<ChevronDown className="h-3.5 w-3.5" />}
          label="指定原文"
          loading={busy === "preprocess"}
          disabled={busy !== null}
          onClick={() => {
            if (!dropdownOpen) void fetchSources();
            setDropdownOpen(!dropdownOpen);
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
                <div className="max-h-60 overflow-y-auto">
                  {sources.map((file) => (
                    <button
                      key={file.name}
                      type="button"
                      onClick={() => void handleSourceSelect(file.name)}
                      className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs text-gray-300 transition-colors hover:bg-gray-800 hover:text-white"
                    >
                      <span className="mr-2 truncate font-mono">{file.name}</span>
                      <span className="shrink-0 text-[0.625rem] text-gray-500">
                        {(file.size / 1024).toFixed(1)} KB
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
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
        onClick={() => void handleBatchStoryboards(false)}
        tone="primary"
      />
      <ActionButton
        icon={<RotateCcw className="h-3.5 w-3.5" />}
        label="強制重生"
        title="強制重生所有分鏡（含已生成）"
        loading={busy === "storyboards"}
        disabled={!hasScript || !scriptFile || busy !== null}
        onClick={async () => {
          if (await confirm({ message: "會覆寫所有已生成分鏡。確定？", danger: true })) {
            void handleBatchStoryboards(true);
          }
        }}
        tone="warning"
      />

      <Divider />

      <ActionButton
        icon={<Film className="h-3.5 w-3.5" />}
        label="批次生成影片"
        loading={busy === "videos"}
        disabled={!hasScript || !scriptFile || busy !== null}
        onClick={() => void handleBatchVideos(false)}
        tone="primary"
      />
      <ActionButton
        icon={<RotateCcw className="h-3.5 w-3.5" />}
        label="強制重生"
        title="強制重生所有影片（含已生成）"
        loading={busy === "videos"}
        disabled={!hasScript || !scriptFile || busy !== null}
        onClick={async () => {
          if (await confirm({ message: "會覆寫所有已生成影片。確定？", danger: true })) {
            void handleBatchVideos(true);
          }
        }}
        tone="warning"
      />

      <Divider />

      <ActionButton
        icon={<FileText className="h-3.5 w-3.5" />}
        label="合成成片"
        loading={busy === "compose"}
        disabled={!hasScript || busy !== null}
        onClick={() => void handleCompose()}
        tone="success"
      />
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
