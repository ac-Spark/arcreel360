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
            <h2 className="text-lg font-semibold text-gray-100">检测到项目编号重复</h2>
            <p className="text-sm leading-6 text-gray-400">
              导入包准备使用的项目编号
              <span className="mx-1 rounded bg-gray-800 px-1.5 py-0.5 font-mono text-gray-200">
                {projectName}
              </span>
              已存在。你可以覆盖现有项目，或自动重命名后继续导入。
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3">
          <button
            type="button"
            onClick={() => onConfirm("overwrite")}
            disabled={importing}
            aria-label="覆盖现有项目"
            className="flex w-full items-center justify-between rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-left text-sm text-red-100 transition-colors hover:border-red-300/40 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>
              <span className="block font-medium">覆盖现有项目</span>
              <span className="mt-1 block text-xs text-red-200/80">
                使用导入包内容替换现有项目编号对应的数据
              </span>
            </span>
            {importing && <Loader2 className="h-4 w-4 animate-spin" />}
          </button>

          <button
            type="button"
            onClick={() => onConfirm("rename")}
            disabled={importing}
            aria-label="自动重命名导入"
            className="flex w-full items-center justify-between rounded-xl border border-indigo-400/25 bg-indigo-500/10 px-4 py-3 text-left text-sm text-indigo-100 transition-colors hover:border-indigo-300/40 hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>
              <span className="block font-medium">自动重命名导入</span>
              <span className="mt-1 block text-xs text-indigo-200/80">
                保留现有项目，新导入项目自动生成新的内部编号
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
      title="导入诊断"
      description="导入已完成预检查。以下问题按严重程度分组展示，阻断问题解决前不会继续导入。"
      sections={[
        { key: "blocking", title: "阻断问题", tone: "border-red-400/25 bg-red-500/10 text-red-100", items: diagnostics.blocking },
        { key: "auto_fixable", title: "可自动修复", tone: "border-indigo-400/25 bg-indigo-500/10 text-indigo-100", items: diagnostics.auto_fixable },
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
  setup: "准备中",
  worldbuilding: "世界观",
  scripting: "剧本创作",
  production: "制作中",
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
          创作工作台
        </div>
        <h3 className="mt-2 truncate text-base font-semibold text-[color:var(--wb-text-primary)]">
          {project.title}
        </h3>
        <p className="mt-1 text-xs text-[color:var(--wb-text-muted)]">
          {project.style || "未设置风格"}
          {phaseLabel ? ` · ${phaseLabel}` : ""}
        </p>
      </div>

      {/* Progress bar */}
      <div className="rounded-2xl border border-white/6 bg-black/12 px-3 py-3">
        <div className="mb-2 flex justify-between text-[11px] uppercase tracking-[0.18em] text-[color:var(--wb-text-dim)]">
          <span>{phaseLabel || "进度"}</span>
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
            <span className="rounded-full border border-white/6 bg-black/12 px-2.5 py-1">线索 {clues.completed}/{clues.total}</span>
          )}
        </div>
      )}

      {/* Episodes summary */}
      {summary && summary.total > 0 && (
        <div className="text-xs leading-6 text-[color:var(--wb-text-muted)]">
          {summary.total} 集
          {summary.scripted > 0 && ` · ${summary.scripted} 集剧本完成`}
          {summary.in_production > 0 && ` · ${summary.in_production} 集制作中`}
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
            ? `项目 "${result.project.title || result.project_name}" 已导入，自动修复 ${autoFixedCount} 项`
            : `项目 "${result.project.title || result.project_name}" 已导入`,
          "success"
        );
        if (warningCount > 0) {
          const warningMessages = result.diagnostics.warnings.map((w) => w.message).join("；");
          useAppStore.getState().pushToast(
            `导入警告: ${warningMessages}`,
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
            `导入失败: ${error.detail || error.message || "导入失败"}`
            + (blockingCount > 0 ? `（${blockingCount} 个阻断问题` : "（0 个阻断问题")
            + (autoFixableCount > 0 ? `，${autoFixableCount} 个可自动修复）` : "）"),
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
            <div className="workbench-kicker text-xs font-semibold">Creative Project Hall</div>
            <h1 className="workbench-title mt-2 flex items-center gap-3 text-[1.9rem] font-semibold tracking-tight">
              <img src="/android-chrome-192x192.png" alt="ArcReel" className="h-8 w-8 rounded-xl" />
              <span>ArcReel 项目工作台</span>
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[color:var(--wb-text-muted)]">
              在同一個入口管理小说转视频项目、导入归档与系统配置，优先突出项目上下文与创作进度，而不是后台表单感。
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
              {importingProject ? "导入中..." : "导入 ZIP"}
            </button>
            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              className="workbench-button-primary inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-medium"
            >
              <Plus className="h-4 w-4" />
              新建项目
            </button>
            <div className="ml-1 flex items-center gap-1 border-l border-[color:var(--wb-border-soft)] pl-3">
              <button
                type="button"
                onClick={() => setShowOpenClaw(true)}
                className="workbench-button-secondary rounded-xl px-2.5 py-1.5 text-sm"
                title="OpenClaw 集成"
                aria-label="OpenClaw 集成指南"
              >
                🦞
              </button>
              <button
                type="button"
                onClick={() => navigate("/app/settings")}
                className="workbench-button-secondary relative rounded-xl p-2"
                title="系统配置"
                aria-label="系统配置"
              >
                <Settings className="h-4 w-4" />
                {!isConfigComplete && (
                  <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-rose-500" aria-label="配置不完整" />
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
              <div className="text-xs uppercase tracking-[0.22em] text-[color:var(--wb-accent-cyan)]">Workspace Overview</div>
              <h2 className="mt-2 text-2xl font-semibold text-[color:var(--wb-text-primary)]">从这里进入每个创作项目</h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[color:var(--wb-text-muted)]">
                項目卡片現在優先顯示上下文、進度與角色/線索完成度，讓入口頁更像創作台總覽，而不是單純資料清單。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              <div className="rounded-2xl border border-white/6 bg-black/12 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--wb-text-dim)]">项目总数</div>
                <div className="mt-2 text-2xl font-semibold text-[color:var(--wb-text-primary)]">{projects.length}</div>
              </div>
              <div className="rounded-2xl border border-white/6 bg-black/12 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--wb-text-dim)]">配置状态</div>
                <div className="mt-2 text-sm font-medium text-[color:var(--wb-text-secondary)]">{isConfigComplete ? "已就绪" : "待完善"}</div>
              </div>
              <div className="rounded-2xl border border-white/6 bg-black/12 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--wb-text-dim)]">快速入口</div>
                <div className="mt-2 text-sm font-medium text-[color:var(--wb-text-secondary)]">导入 ZIP / 新建项目 / 设置中心</div>
              </div>
            </div>
          </div>
        </section>

        {projectsLoading ? (
          <div className="workbench-panel flex items-center justify-center rounded-[1.4rem] py-20">
            <Loader2 className="h-6 w-6 animate-spin text-[color:var(--wb-accent)]" />
            <span className="ml-2 text-[color:var(--wb-text-muted)]">加载项目列表...</span>
          </div>
        ) : projects.length === 0 ? (
          <div className="workbench-panel flex flex-col items-center justify-center rounded-[1.4rem] py-20 text-[color:var(--wb-text-muted)]">
            <FolderOpen className="h-16 w-16 mb-4" />
            <p className="text-lg text-[color:var(--wb-text-primary)]">暂无项目</p>
            <p className="text-sm mt-1">点击右上角「新建项目」或「导入 ZIP」开始创作</p>
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
