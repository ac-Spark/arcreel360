import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Users,
  Puzzle,
  Film,
  Circle,
  User,
  LayoutDashboard,
  Plus,
  Upload,
  Trash2,
  GripVertical,
  X,
} from "lucide-react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useProjectsStore } from "@/stores/projects-store";
import { useAppStore } from "@/stores/app-store";
import { useConfirm } from "@/hooks/useConfirm";
import { API } from "@/api";
import { sortEpisodesForDisplay } from "@/utils/episodes";
import type { EpisodeMeta } from "@/types";

// ---------------------------------------------------------------------------
// CollapsibleSection — reusable accordion primitive
// ---------------------------------------------------------------------------

function CollapsibleSection({
  title,
  icon: Icon,
  children,
  defaultOpen = true,
  action,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  defaultOpen?: boolean;
  action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section>
      <div className="flex w-full items-center">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="focus-ring flex flex-1 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[color:var(--wb-text-dim)] transition-colors hover:text-[color:var(--wb-text-secondary)]"
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )}
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span>{title}</span>
        </button>
        {action && <div className="pr-2">{action}</div>}
      </div>
      {open && <div className="pb-1">{children}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Status dot color mapping
// ---------------------------------------------------------------------------

const STATUS_DOT_CLASSES: Record<string, string> = {
  draft: "text-gray-500",
  in_production: "text-amber-500",
  completed: "text-emerald-500",
  missing: "text-red-500",
};

// ---------------------------------------------------------------------------
// CharacterThumbnail — round avatar with fallback
// ---------------------------------------------------------------------------

function CharacterThumbnail({
  name,
  sheetPath,
  projectName,
}: {
  name: string;
  sheetPath: string | undefined;
  projectName: string;
}) {
  const sheetFp = useProjectsStore((s) =>
    sheetPath ? s.getAssetFingerprint(sheetPath) : null,
  );
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [sheetFp, sheetPath]);

  if (!sheetPath || imgError) {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/6 bg-black/16 text-[color:var(--wb-text-muted)]">
        <User className="h-3.5 w-3.5" />
      </span>
    );
  }

  return (
    <img
      src={API.getFileUrl(projectName, sheetPath, sheetFp)}
      alt={name}
      className="h-6 w-6 shrink-0 rounded-full object-cover"
      onError={() => setImgError(true)}
    />
  );
}

// ---------------------------------------------------------------------------
// ClueThumbnail — square icon with fallback
// ---------------------------------------------------------------------------

function ClueThumbnail({
  name,
  sheetPath,
  projectName,
}: {
  name: string;
  sheetPath: string | undefined;
  projectName: string;
}) {
  const sheetFp = useProjectsStore((s) =>
    sheetPath ? s.getAssetFingerprint(sheetPath) : null,
  );
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [sheetFp, sheetPath]);

  if (!sheetPath || imgError) {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-white/6 bg-black/16 text-[color:var(--wb-text-muted)]">
        <Puzzle className="h-3.5 w-3.5" />
      </span>
    );
  }

  return (
    <img
      src={API.getFileUrl(projectName, sheetPath, sheetFp)}
      alt={name}
      className="h-6 w-6 shrink-0 rounded object-cover"
      onError={() => setImgError(true)}
    />
  );
}

// ---------------------------------------------------------------------------
// EmptyState — shared empty placeholder
// ---------------------------------------------------------------------------

function EmptyState({ text }: { text: string }) {
  return (
    <p className="px-3 py-1.5 text-xs italic text-[color:var(--wb-text-dim)]">{text}</p>
  );
}

function getNextEpisodeNumber(episodes: Array<{ episode: unknown }>): number {
  return episodes.reduce((max, ep) => Math.max(max, Number(ep.episode) || 0), 0) + 1;
}

// ---------------------------------------------------------------------------
// SortableEpisodeRow — single draggable row in the episode list
// ---------------------------------------------------------------------------

type SortableEpisodeRowProps = {
  ep: EpisodeMeta;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
};

function SortableEpisodeRow({
  ep,
  active,
  onSelect,
  onDelete,
}: SortableEpisodeRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ep.episode,
  });
  const episodeTitle = ep.title || "（未命名劇集）";
  const isSegmented = ep.script_status === "segmented";
  const statusKey = isSegmented ? "draft" : (ep.status ?? "draft");
  const statusClass = STATUS_DOT_CLASSES[statusKey] ?? STATUS_DOT_CLASSES.draft;
  const toneClass = active
    ? "workbench-panel-strong text-[color:var(--wb-text-primary)]"
    : "text-[color:var(--wb-text-secondary)] hover:bg-black/12 hover:text-[color:var(--wb-text-primary)]";

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <li ref={setNodeRef} style={style}>
      <div
        className={`group flex w-full items-center gap-1 px-3 py-1.5 text-sm transition-colors ${toneClass}`}
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="focus-ring shrink-0 cursor-grab touch-none rounded p-0.5 text-[color:var(--wb-text-dim)] opacity-0 transition-opacity hover:text-[color:var(--wb-text-secondary)] group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
          title="拖曳調整順序"
          aria-label="拖曳調整順序"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-2 truncate text-left focus-ring rounded"
        >
          <Circle
            className={`h-2.5 w-2.5 shrink-0 fill-current ${statusClass}`}
          />
          <span className="truncate">{episodeTitle}</span>
          {isSegmented && !ep.scenes_count && (
            <span className="ml-auto shrink-0 rounded-full border border-[rgba(136,163,255,0.16)] bg-[rgba(109,140,255,0.12)] px-2 py-0.5 text-[10px] text-[color:var(--wb-accent)]">
              預處理
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="focus-ring shrink-0 rounded p-0.5 text-[color:var(--wb-text-dim)] opacity-0 transition-opacity hover:text-[color:var(--wb-danger)] group-hover:opacity-100 focus-visible:opacity-100"
          title="刪除整集"
          aria-label={`刪除「${episodeTitle}」`}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// AssetSidebar
// ---------------------------------------------------------------------------

interface AssetSidebarProps {
  className?: string;
}

export function AssetSidebar({ className }: AssetSidebarProps) {
  const { currentProjectData, currentProjectName, currentScripts } = useProjectsStore();
  const sourceFilesVersion = useAppStore((s) => s.sourceFilesVersion);
  const [location, setLocation] = useLocation();
  const confirm = useConfirm();

  const characters = currentProjectData?.characters ?? {};
  const clues = currentProjectData?.clues ?? {};
  const episodes = currentProjectData?.episodes ?? [];
  const projectName = currentProjectName ?? "";

  // 原始檔列表
  const [sourceFiles, setSourceFiles] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [creatingEpisode, setCreatingEpisode] = useState(false);

  const loadSourceFiles = useCallback(() => {
    if (!projectName) {
      setSourceFiles([]);
      return;
    }
    API.listFiles(projectName)
      .then((res) => {
        const raw = res.files as unknown;
        if (Array.isArray(raw)) {
          setSourceFiles(raw);
        } else if (raw && typeof raw === "object") {
          const grouped = raw as Record<string, Array<{ name: string }>>;
          setSourceFiles((grouped.source ?? []).map((f) => f.name));
        }
      })
      .catch(() => {
        setSourceFiles([]);
      });
  }, [projectName]);

  useEffect(() => {
    loadSourceFiles();
  }, [loadSourceFiles, sourceFilesVersion]);

  // 上傳原始檔
  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !projectName) return;
    try {
      await API.uploadFile(projectName, "source", file);
      loadSourceFiles();
      useAppStore.getState().invalidateSourceFiles();
    } catch {
      // 靜默失敗
    }
    // 重置 input 以允許再次選擇同一檔案
    e.target.value = "";
  }, [projectName, loadSourceFiles]);

  // 刪除原始檔
  const handleDeleteFile = useCallback(async (filename: string) => {
    if (!projectName) return;
    const ok = await confirm({
      message: `確定要刪除「${filename}」嗎？`,
      danger: true,
    });
    if (!ok) return;
    try {
      await API.deleteSourceFile(projectName, filename);
      loadSourceFiles();
      useAppStore.getState().invalidateSourceFiles();
      // 如果當前正在檢視該檔案，返回概覽
      if (location === `/source/${encodeURIComponent(filename)}`) {
        setLocation("/");
      }
    } catch {
      // 靜默失敗
    }
  }, [projectName, loadSourceFiles, location, setLocation, confirm]);

  const handleCreateEpisode = useCallback(async () => {
    if (!projectName || creatingEpisode) return;
    const nextEpisode = getNextEpisodeNumber(episodes);
    setCreatingEpisode(true);
    try {
      const res = await API.createEpisode(projectName, { episode: nextEpisode });
      useProjectsStore
        .getState()
        .setCurrentProject(projectName, res.project, currentScripts);
      setLocation(`/episodes/${res.episode.episode}`);
      useAppStore.getState().pushToast(`E${res.episode.episode} 已新增`, "success");
    } catch (err) {
      useAppStore.getState().pushToast(`新增劇本失敗: ${(err as Error).message}`, "error");
    } finally {
      setCreatingEpisode(false);
    }
  }, [projectName, creatingEpisode, episodes, currentScripts, setLocation]);

  const sortedEpisodes = useMemo(
    () => sortEpisodesForDisplay(episodes),
    [episodes],
  );
  const sortedEpisodeIds = useMemo(
    () => sortedEpisodes.map((ep) => ep.episode),
    [sortedEpisodes],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const handleReorderEpisodes = useCallback(
    async (orderedEpisodeNumbers: number[]) => {
      if (!projectName) return;
      const { currentProjectData: snapshot, assetFingerprints } = useProjectsStore.getState();
      if (!snapshot) return;
      // 樂觀更新：把新順序對映成 order 寫回，store 立刻 re-render
      const orderMap = new Map(orderedEpisodeNumbers.map((ep, idx) => [ep, idx]));
      const nextEpisodes = (snapshot.episodes ?? []).map((ep) => ({
        ...ep,
        order: orderMap.get(ep.episode) ?? ep.order,
      }));
      useProjectsStore.getState().setCurrentProject(
        projectName,
        { ...snapshot, episodes: nextEpisodes },
        currentScripts,
        assetFingerprints,
      );
      try {
        await API.reorderEpisodes(projectName, orderedEpisodeNumbers);
      } catch (err) {
        useAppStore.getState().pushToast(`調整順序失敗：${(err as Error).message}`, "error");
        // 失敗：重抓專案還原真實狀態
        try {
          const fresh = await API.getProject(projectName);
          useProjectsStore.getState().setCurrentProject(
            projectName,
            fresh.project,
            fresh.scripts ?? {},
            fresh.asset_fingerprints,
          );
        } catch {
          // 連 refetch 都失敗就放棄
        }
      }
    },
    [projectName, currentScripts],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = sortedEpisodeIds.indexOf(Number(active.id));
      const newIndex = sortedEpisodeIds.indexOf(Number(over.id));
      if (oldIndex < 0 || newIndex < 0) return;
      const next = arrayMove(sortedEpisodeIds, oldIndex, newIndex);
      void handleReorderEpisodes(next);
    },
    [sortedEpisodeIds, handleReorderEpisodes],
  );

  const handleDeleteEpisode = useCallback(
    async (episode: number, title: string) => {
      if (!projectName) return;
      const confirmed = await confirm({
        message: `確定要刪除「E${episode}: ${title}」整集嗎？會一併刪掉這集的劇本、預處理草稿、分鏡與影片。此操作無法復原。`,
        danger: true,
      });
      if (!confirmed) return;

      try {
        const res = await API.deleteEpisode(projectName, episode);
        const nextScripts = { ...currentScripts };
        delete nextScripts[`episode_${episode}.json`];
        useProjectsStore
          .getState()
          .setCurrentProject(projectName, res.project, nextScripts);
        if (location === `/episodes/${episode}`) setLocation("/");
        useAppStore.getState().pushToast(`已刪除 E${episode}`, "success");
      } catch (err) {
        useAppStore
          .getState()
          .pushToast(`刪除劇集失敗: ${(err as Error).message}`, "error");
      }
    },
    [projectName, currentScripts, location, setLocation, confirm],
  );

  const characterEntries = Object.entries(characters);
  const clueEntries = Object.entries(clues);

  // Check if a path is active (matches current nested location)
  const isActive = (path: string) => location === path;

  return (
    <aside
      className={`workbench-panel-subtle flex flex-col overflow-y-auto ${className ?? ""}`}
    >
      {/* ---- Project Overview nav item ---- */}
      <button
        type="button"
        onClick={() => setLocation("/")}
        className={`focus-ring flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm transition-colors ${isActive("/")
          ? "workbench-panel-strong text-[color:var(--wb-text-primary)]"
          : "text-[color:var(--wb-text-secondary)] hover:bg-black/12 hover:text-[color:var(--wb-text-primary)]"
          }`}
      >
        <LayoutDashboard className="h-4 w-4 shrink-0 text-[color:var(--wb-accent)]" />
        <span className="font-medium">專案總覽</span>
      </button>

      {/* ---- Divider ---- */}
      <div className="mx-3 border-t border-[color:var(--wb-border-soft)]" />

      {/* ---- Section 1: Source Files ---- */}
      <CollapsibleSection
        title="原始檔案"
        icon={FileText}
        action={
          <>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="focus-ring rounded-lg p-1 text-[color:var(--wb-text-dim)] transition-colors hover:bg-black/16 hover:text-[color:var(--wb-text-secondary)]"
              title="上傳原始檔案"
            >
              <Upload className="h-3.5 w-3.5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.doc,.docx"
              onChange={handleUpload}
              className="hidden"
            />
          </>
        }
      >
        {sourceFiles.length === 0 ? (
          <EmptyState text="暫無檔案" />
        ) : (
          <ul>
            {sourceFiles.map((name) => {
              const filePath = `/source/${encodeURIComponent(name)}`;
              const active = isActive(filePath);
              return (
                <li key={name}>
                  <div
                    className={`group flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors ${active
                      ? "workbench-panel-strong text-[color:var(--wb-text-primary)]"
                      : "text-[color:var(--wb-text-secondary)] hover:bg-black/12 hover:text-[color:var(--wb-text-primary)]"
                      }`}
                  >
                    <button
                      type="button"
                      onClick={() => setLocation(filePath)}
                      className="flex flex-1 items-center gap-2 truncate text-left focus-ring rounded"
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0 text-[color:var(--wb-text-dim)]" />
                      <span className="truncate">{name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleDeleteFile(name); }}
                      className="focus-ring shrink-0 rounded p-0.5 text-[color:var(--wb-text-dim)] opacity-0 transition-opacity hover:text-[color:var(--wb-danger)] group-hover:opacity-100 focus-visible:opacity-100"
                      title="刪除檔案"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CollapsibleSection>

      {/* ---- Divider ---- */}
      <div className="mx-3 border-t border-[color:var(--wb-border-soft)]" />

      {/* ---- Section 2: Lorebook (Characters + Clues) ---- */}
      <CollapsibleSection title="設定集" icon={Users} defaultOpen={true}>
        {/* Characters sub-section */}
        <div className="mb-1">
          <button
            type="button"
            onClick={() => setLocation("/characters")}
            className={`focus-ring flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors ${isActive("/characters")
              ? "text-[color:var(--wb-text-primary)]"
              : "text-[color:var(--wb-text-dim)] hover:text-[color:var(--wb-text-secondary)]"
              }`}
          >
            <Users className="h-3 w-3" />
            <span>角色</span>
          </button>
          {characterEntries.length === 0 ? (
            <button
              type="button"
              onClick={() => setLocation("/characters")}
              className="focus-ring w-full px-3 py-1.5 text-left text-xs text-[color:var(--wb-text-dim)] italic hover:text-[color:var(--wb-text-secondary)]"
            >
              暫無角色，點選新增
            </button>
          ) : (
            <ul>
              {characterEntries.map(([name, char]) => (
                <li key={name}>
                  <button
                    type="button"
                    onClick={() => setLocation("/characters")}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors focus-ring ${isActive("/characters")
                      ? "workbench-panel-strong text-[color:var(--wb-text-primary)]"
                      : "text-[color:var(--wb-text-secondary)] hover:bg-black/12 hover:text-[color:var(--wb-text-primary)]"
                      }`}
                  >
                    <CharacterThumbnail
                      name={name}
                      sheetPath={char.character_sheet}
                      projectName={projectName}
                    />
                    <span className="truncate">{name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Clues sub-section */}
        <div>
          <button
            type="button"
            onClick={() => setLocation("/clues")}
            className={`focus-ring flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors ${isActive("/clues")
              ? "text-[color:var(--wb-text-primary)]"
              : "text-[color:var(--wb-text-dim)] hover:text-[color:var(--wb-text-secondary)]"
              }`}
          >
            <Puzzle className="h-3 w-3" />
            <span>道具</span>
          </button>
          {clueEntries.length === 0 ? (
            <button
              type="button"
              onClick={() => setLocation("/clues")}
              className="focus-ring w-full px-3 py-1.5 text-left text-xs text-[color:var(--wb-text-dim)] italic hover:text-[color:var(--wb-text-secondary)]"
            >
              暫無道具，點選新增
            </button>
          ) : (
            <ul>
              {clueEntries.map(([name, clue]) => (
                <li key={name}>
                  <button
                    type="button"
                    onClick={() => setLocation("/clues")}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors focus-ring ${isActive("/clues")
                      ? "workbench-panel-strong text-[color:var(--wb-text-primary)]"
                      : "text-[color:var(--wb-text-secondary)] hover:bg-black/12 hover:text-[color:var(--wb-text-primary)]"
                      }`}
                  >
                    <ClueThumbnail
                      name={name}
                      sheetPath={clue.clue_sheet}
                      projectName={projectName}
                    />
                    <span className="truncate">{name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CollapsibleSection>

      {/* ---- Divider ---- */}
      <div className="mx-3 border-t border-[color:var(--wb-border-soft)]" />

      {/* ---- Section 3: Episodes ---- */}
      <CollapsibleSection
        title="劇本"
        icon={Film}
        action={
          <button
            type="button"
            onClick={handleCreateEpisode}
            disabled={!projectName || creatingEpisode}
            className="focus-ring rounded-lg p-1 text-[color:var(--wb-text-dim)] transition-colors hover:bg-black/16 hover:text-[color:var(--wb-text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
            title="新增劇本"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        }
      >
        {episodes.length === 0 ? (
          <button
            type="button"
            onClick={handleCreateEpisode}
            disabled={!projectName || creatingEpisode}
            className="focus-ring w-full px-3 py-1.5 text-left text-xs text-[color:var(--wb-text-dim)] italic hover:text-[color:var(--wb-text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            暫無劇本，點選新增
          </button>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={sortedEpisodeIds}
              strategy={verticalListSortingStrategy}
            >
              <ul>
                {sortedEpisodes.map((ep) => (
                  <SortableEpisodeRow
                    key={ep.episode}
                    ep={ep}
                    active={isActive(`/episodes/${ep.episode}`)}
                    onSelect={() => setLocation(`/episodes/${ep.episode}`)}
                    onDelete={() =>
                      void handleDeleteEpisode(Number(ep.episode), String(ep.title ?? ""))
                    }
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </CollapsibleSection>
    </aside>
  );
}
