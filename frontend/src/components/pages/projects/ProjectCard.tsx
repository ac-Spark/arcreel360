import { useLocation } from "wouter";
import { FolderOpen } from "lucide-react";
import type { ProjectStatus, ProjectSummary } from "@/types";

const PHASE_LABELS: Record<string, string> = {
  setup: "準備中",
  worldbuilding: "世界觀",
  scripting: "劇本創作",
  production: "製作中",
  completed: "已完成",
};

export function ProjectCard({ project }: { project: ProjectSummary }) {
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
