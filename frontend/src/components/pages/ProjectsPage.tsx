import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, Plus, FolderOpen, Upload, AlertTriangle, Settings } from "lucide-react";
import { API } from "@/api";
import { useProjectsStore } from "@/stores/projects-store";
import { useAppStore } from "@/stores/app-store";
import { useConfigStatusStore } from "@/stores/config-status-store";
import { CreateProjectModal } from "./CreateProjectModal";
import { OpenClawModal } from "./OpenClawModal";
import { ArchiveDiagnosticsDialog } from "@/components/shared/ArchiveDiagnosticsDialog";
import type {
  ImportConflictPolicy,
  ImportFailureDiagnostics,
  ProjectSummary,
  ProjectStatus,
} from "@/types";

interface ImportConflictDialogProps {
  projectName: string;
  importing: boolean;
  onCancel: () => void;
  onConfirm: (policy: Extract<ImportConflictPolicy, "rename" | "overwrite">) => void;
}

function ImportConflictDialog({
  projectName,
  importing,
  onCancel,
  onConfirm,
}: ImportConflictDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4">
      <div className="w-full max-w-md rounded-2xl border border-amber-400/20 bg-gray-900 p-6 shadow-2xl shadow-black/40">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-amber-400/10 p-2 text-amber-300">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-gray-100">偵測到專案編號重複</h2>
            <p className="text-sm leading-6 text-gray-400">
              匯入包準備使用的專案編號
              <span className="mx-1 rounded bg-gray-800 px-1.5 py-0.5 font-mono text-gray-200">
                {projectName}
              </span>
              已存在。你可以覆蓋現有專案，或自動重新命名後繼續匯入。
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3">
          <button
            type="button"
            onClick={() => onConfirm("overwrite")}
            disabled={importing}
            aria-label="覆蓋現有專案"
            className="flex w-full items-center justify-between rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-left text-sm text-red-100 transition-colors hover:border-red-300/40 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>
              <span className="block font-medium">覆蓋現有專案</span>
              <span className="mt-1 block text-xs text-red-200/80">
                使用匯入包內容取代現有專案編號對應的資料
              </span>
            </span>
            {importing && <Loader2 className="h-4 w-4 animate-spin" />}
          </button>

          <button
            type="button"
            onClick={() => onConfirm("rename")}
            disabled={importing}
            aria-label="自動重新命名匯入"
            className="flex w-full items-center justify-between rounded-xl border border-indigo-400/25 bg-indigo-500/10 px-4 py-3 text-left text-sm text-indigo-100 transition-colors hover:border-indigo-300/40 hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>
              <span className="block font-medium">自動重新命名匯入</span>
              <span className="mt-1 block text-xs text-indigo-200/80">
                保留現有專案，新匯入專案自動產生新的內部編號
              </span>
            </span>
            {importing && <Loader2 className="h-4 w-4 animate-spin" />}
          </button>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={importing}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 transition-colors hover:border-gray-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

function fallbackDiagnostics(error: {
  errors?: string[];
  warnings?: string[];
  diagnostics?: ImportFailureDiagnostics;
}): ImportFailureDiagnostics {
  if (error.diagnostics) {
    return error.diagnostics;
  }
  return {
    blocking: (error.errors ?? []).map((message) => ({
      code: "legacy_error",
      message,
    })),
    auto_fixable: [],
    warnings: (error.warnings ?? []).map((message) => ({
      code: "legacy_warning",
      message,
    })),
  };
}

function ImportDiagnosticsDialogWrapper({
  diagnostics,
  onClose,
}: {
  diagnostics: ImportFailureDiagnostics;
  onClose: () => void;
}) {
  return (
    <ArchiveDiagnosticsDialog
      title="匯入診斷"
      description="匯入已完成預先檢查。以下問題會依嚴重程度分組顯示，在阻斷問題排除前不會繼續匯入。"
      sections={[
        { key: "blocking", title: "阻斷問題", tone: "border-red-400/25 bg-red-500/10 text-red-100", items: diagnostics.blocking },
        { key: "auto_fixable", title: "可自動修復", tone: "border-indigo-400/25 bg-indigo-500/10 text-indigo-100", items: diagnostics.auto_fixable },
        { key: "warnings", title: "警告", tone: "border-amber-400/25 bg-amber-500/10 text-amber-100", items: diagnostics.warnings },
      ]}
      onClose={onClose}
    />
  );
}

// ---------------------------------------------------------------------------
// Phase display helpers
// ---------------------------------------------------------------------------

const PHASE_LABELS: Record<string, string> = {
  setup: "準備中",
  worldbuilding: "世界觀",
  scripting: "劇本創作",
  production: "製作中",
  completed: "已完成",
};

// ---------------------------------------------------------------------------
// ProjectCard — single project entry
// ---------------------------------------------------------------------------

function ProjectCard({ project }: { project: ProjectSummary }) {
  const [, navigate] = useLocation();
  const status = project.status;
  const hasStatus = status && "current_phase" in status;

  const pct = hasStatus ? Math.round((status as ProjectStatus).phase_progress * 100) : 0;
  const phase = hasStatus ? (status as ProjectStatus).current_phase : "";
  const phaseLabel = PHASE_LABELS[phase] ?? phase;
  const characters = hasStatus ? (status as ProjectStatus).characters : null;
  const clues = hasStatus ? (status as ProjectStatus).clues : null;
  const summary = hasStatus ? (status as ProjectStatus).episodes_summary : null;

  return (
    <button
      type="button"
      onClick={() => navigate(`/app/projects/${project.name}`)}
      className="project-card workbench-panel hover:workbench-panel-strong group relative flex cursor-pointer flex-col gap-4 overflow-hidden rounded-[1.35rem] p-5 text-left"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white/6 to-transparent opacity-70" />

      {/* Thumbnail or placeholder */}
      <div className="relative aspect-video w-full overflow-hidden rounded-[1rem] border border-white/6 bg-[rgba(10,16,28,0.86)]">
        {project.thumbnail ? (
          <img
            src={project.thumbnail}
            alt={project.title}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[color:var(--wb-text-dim)]">
            <FolderOpen className="h-10 w-10" />
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/35 to-transparent" />
      </div>

      {/* Info */}
      <div className="relative z-10">
        <div className="text-[11px] uppercase tracking-[0.24em] text-[color:var(--wb-accent-cyan)]">
          創作工作臺
        </div>
        <h3 className="mt-2 truncate text-base font-semibold text-[color:var(--wb-text-primary)]">
          {project.title}
        </h3>
        <p className="mt-1 text-xs text-[color:var(--wb-text-muted)]">
          {project.style || "未設定風格"}
          {phaseLabel ? ` · ${phaseLabel}` : ""}
        </p>
      </div>

      {/* Progress bar */}
      <div className="rounded-2xl border border-white/6 bg-black/12 px-3 py-3">
        <div className="mb-2 flex justify-between text-[11px] uppercase tracking-[0.18em] text-[color:var(--wb-text-dim)]">
          <span>{phaseLabel || "進度"}</span>
          <span>{pct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[rgba(129,146,181,0.16)]">
          <div
            className="h-full rounded-full bg-[linear-gradient(90deg,var(--wb-accent),var(--wb-accent-cyan))] transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Characters & Clues — always shown */}
      {(characters || clues) && (
        <div className="flex flex-wrap gap-2 text-xs text-[color:var(--wb-text-muted)]">
          {characters && (
            <span className="rounded-full border border-white/6 bg-black/12 px-2.5 py-1">角色 {characters.completed}/{characters.total}</span>
          )}
          {clues && (
            <span className="rounded-full border border-white/6 bg-black/12 px-2.5 py-1">道具 {clues.completed}/{clues.total}</span>
          )}
        </div>
      )}

      {/* Episodes summary */}
      {summary && summary.total > 0 && (
        <div className="text-xs leading-6 text-[color:var(--wb-text-muted)]">
          {summary.total} 集
          {summary.scripted > 0 && ` · ${summary.scripted} 集劇本完成`}
          {summary.in_production > 0 && ` · ${summary.in_production} 集製作中`}
          {summary.completed > 0 && ` · ${summary.completed} 集已完成`}
        </div>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// ProjectsPage — project list with create button
// ---------------------------------------------------------------------------

export function ProjectsPage() {
  const [, navigate] = useLocation();
  const { projects, projectsLoading, showCreateModal, setProjects, setProjectsLoading, setShowCreateModal } =
    useProjectsStore();
  const [importingProject, setImportingProject] = useState(false);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [conflictProjectName, setConflictProjectName] = useState<string | null>(null);
  const [importDiagnostics, setImportDiagnostics] = useState<ImportFailureDiagnostics | null>(null);
  const [showOpenClaw, setShowOpenClaw] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const isConfigComplete = useConfigStatusStore((s) => s.isComplete);
  const fetchConfigStatus = useConfigStatusStore((s) => s.fetch);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const res = await API.listProjects();
      setProjects(res.projects);
    } catch {
      // silently fail — user can retry
    } finally {
      setProjectsLoading(false);
    }
  }, [setProjects, setProjectsLoading]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await loadProjects();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadProjects]);

  useEffect(() => {
    void fetchConfigStatus();
  }, [fetchConfigStatus]);

  const finishImport = useCallback(
    async (
      file: File,
      policy: ImportConflictPolicy,
      options?: { keepConflictDialog?: boolean },
    ) => {
      setImportingProject(true);
      try {
        const result = await API.importProject(file, policy);
        setPendingImportFile(null);
        setConflictProjectName(null);
        setImportDiagnostics(null);
        await loadProjects();

        const autoFixedCount = result.diagnostics.auto_fixed.length;
        const warningCount = result.diagnostics.warnings.length;
        useAppStore.getState().pushToast(
          autoFixedCount > 0
            ? `專案「${result.project.title || result.project_name}」已匯入，自動修復 ${autoFixedCount} 項`
            : `專案「${result.project.title || result.project_name}」已匯入`,
          "success"
        );
        if (warningCount > 0) {
          const warningMessages = result.diagnostics.warnings.map((w) => w.message).join("；");
          useAppStore.getState().pushToast(
            `匯入警告：${warningMessages}`,
            "warning"
          );
        }

        navigate(`/app/projects/${result.project_name}`);
      } catch (err) {
        const error = err as Error & {
          status?: number;
          detail?: string;
          errors?: string[];
          warnings?: string[];
          diagnostics?: ImportFailureDiagnostics;
          conflict_project_name?: string;
        };

        if (
          error.status === 409 &&
          error.conflict_project_name &&
          policy === "prompt"
        ) {
          setPendingImportFile(file);
          setConflictProjectName(error.conflict_project_name);
          return;
        }

        if (!options?.keepConflictDialog) {
          setPendingImportFile(null);
          setConflictProjectName(null);
        }

        const diagnostics = fallbackDiagnostics(error);
        setImportDiagnostics(diagnostics);
        const blockingCount = diagnostics.blocking.length;
        const autoFixableCount = diagnostics.auto_fixable.length;

        useAppStore
          .getState()
          .pushToast(
            `匯入失敗：${error.detail || error.message || "匯入失敗"}`
            + (blockingCount > 0 ? `（${blockingCount} 個阻斷問題` : "（0 個阻斷問題")
            + (autoFixableCount > 0 ? `，${autoFixableCount} 個可自動修復）` : "）"),
            "error"
          );
      } finally {
        setImportingProject(false);
      }
    },
    [loadProjects, navigate],
  );

  const handleImport = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file || importingProject) return;

      setImportDiagnostics(null);
      await finishImport(file, "prompt");
    },
    [finishImport, importingProject],
  );

  const handleResolveConflict = useCallback(
    async (policy: Extract<ImportConflictPolicy, "rename" | "overwrite">) => {
      if (!pendingImportFile) return;
      await finishImport(pendingImportFile, policy, { keepConflictDialog: true });
    },
    [finishImport, pendingImportFile],
  );

  const handleCancelConflict = useCallback(() => {
    if (importingProject) return;
    setPendingImportFile(null);
    setConflictProjectName(null);
  }, [importingProject]);

  return (
    <div className="workbench-shell workbench-grid min-h-screen text-[color:var(--wb-text-primary)]">
      {/* Header */}
      <header className="relative border-b border-[color:var(--wb-border-soft)] px-6 py-5 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-start justify-between gap-6">
          <div>
            <div className="workbench-kicker text-xs font-semibold">創作專案大廳</div>
            <h1 className="workbench-title mt-2 flex items-center gap-3 text-[1.9rem] font-semibold tracking-tight">
              <img src="/android-chrome-192x192.png" alt="ArcReel" className="h-8 w-8 rounded-xl" />
              <span>ArcReel 專案工作臺</span>
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[color:var(--wb-text-muted)]">
              在同一個入口管理小說轉影片專案、匯入封存與系統設定，優先突顯專案脈絡與創作進度，而不是後臺表單感。
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              disabled={importingProject}
              className="workbench-button-secondary inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            >
              {importingProject ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {importingProject ? "匯入中..." : "匯入 ZIP"}
            </button>
            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              className="workbench-button-primary inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-medium"
            >
              <Plus className="h-4 w-4" />
              新建專案
            </button>
            <div className="ml-1 flex items-center gap-1 border-l border-[color:var(--wb-border-soft)] pl-3">
              <button
                type="button"
                onClick={() => setShowOpenClaw(true)}
                className="workbench-button-secondary rounded-xl px-2.5 py-1.5 text-sm"
                title="OpenClaw 整合"
                aria-label="OpenClaw 整合指南"
              >
                🦞
              </button>
              <button
                type="button"
                onClick={() => navigate("/app/settings")}
                className="workbench-button-secondary relative rounded-xl p-2"
                title="系統設定"
                aria-label="系統設定"
              >
                <Settings className="h-4 w-4" />
                {!isConfigComplete && (
                  <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-rose-500" aria-label="設定不完整" />
                )}
              </button>
            </div>
          </div>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept=".zip,application/zip"
          onChange={handleImport}
          className="hidden"
        />
      </header>

      {/* Content */}
      <main className="relative mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
        <section className="workbench-panel-strong relative overflow-hidden rounded-[1.6rem] px-6 py-6">
          <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-r from-[rgba(109,140,255,0.16)] via-transparent to-[rgba(112,199,217,0.16)]" />
          <div className="relative grid gap-4 lg:grid-cols-[1.7fr_1fr]">
            <div>
              <div className="text-xs uppercase tracking-[0.22em] text-[color:var(--wb-accent-cyan)]">工作臺總覽</div>
              <h2 className="mt-2 text-2xl font-semibold text-[color:var(--wb-text-primary)]">從這裡進入每個創作專案</h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[color:var(--wb-text-muted)]">
                專案卡片現在優先顯示脈絡、進度與角色／道具完成度，讓入口頁更像創作工作臺總覽，而不是單純的資料清單。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              <div className="rounded-2xl border border-white/6 bg-black/12 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--wb-text-dim)]">專案總數</div>
                <div className="mt-2 text-2xl font-semibold text-[color:var(--wb-text-primary)]">{projects.length}</div>
              </div>
              <div className="rounded-2xl border border-white/6 bg-black/12 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--wb-text-dim)]">設定狀態</div>
                <div className="mt-2 text-sm font-medium text-[color:var(--wb-text-secondary)]">{isConfigComplete ? "已就緒" : "待完善"}</div>
              </div>
              <div className="rounded-2xl border border-white/6 bg-black/12 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--wb-text-dim)]">快速入口</div>
                <div className="mt-2 text-sm font-medium text-[color:var(--wb-text-secondary)]">匯入 ZIP / 新建專案 / 設定中心</div>
              </div>
            </div>
          </div>
        </section>

        {projectsLoading ? (
          <div className="workbench-panel flex items-center justify-center rounded-[1.4rem] py-20">
            <Loader2 className="h-6 w-6 animate-spin text-[color:var(--wb-accent)]" />
            <span className="ml-2 text-[color:var(--wb-text-muted)]">載入專案列表...</span>
          </div>
        ) : projects.length === 0 ? (
          <div className="workbench-panel flex flex-col items-center justify-center rounded-[1.4rem] py-20 text-[color:var(--wb-text-muted)]">
            <FolderOpen className="h-16 w-16 mb-4" />
            <p className="text-lg text-[color:var(--wb-text-primary)]">暫無專案</p>
            <p className="text-sm mt-1">點選右上角「新建專案」或「匯入 ZIP」開始創作</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard key={p.name} project={p} />
            ))}
          </div>
        )}
      </main>

      {/* Create project modal */}
      {showCreateModal && <CreateProjectModal />}
      {conflictProjectName !== null && pendingImportFile !== null && (
        <ImportConflictDialog
          projectName={conflictProjectName}
          importing={importingProject}
          onCancel={handleCancelConflict}
          onConfirm={handleResolveConflict}
        />
      )}
      {importDiagnostics !== null && (
        <ImportDiagnosticsDialogWrapper
          diagnostics={importDiagnostics}
          onClose={() => setImportDiagnostics(null)}
        />
      )}
      {showOpenClaw && <OpenClawModal onClose={() => setShowOpenClaw(false)} />}
    </div>
  );
}
