import { useState, useEffect, useMemo } from "react";
import { User, Puzzle, Mountain, Plus, Sparkles, ChevronDown } from "lucide-react";
import { API } from "@/api";
import { CharacterCard } from "./CharacterCard";
import { ClueCard } from "./ClueCard";
import { SceneCard } from "./SceneCard";
import { LorebookAIExtractModal } from "./LorebookAIExtractModal";
import { useScrollTarget } from "@/hooks/useScrollTarget";
import { useConfirm } from "@/hooks/useConfirm";
import { useAppStore } from "@/stores/app-store";
import type { Character, Clue, Scene, ProviderInfo } from "@/types";
import { providersApi } from "@/api/providers";
import { buildMediaModelOptions } from "@/utils/provider-models";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface LorebookGalleryProps {
  projectName: string;
  characters: Record<string, Character>;
  clues: Record<string, Clue>;
  /** 舊專案可能沒有 scenes，預設視為空 */
  scenes?: Record<string, Scene>;
  /** When specified, only show the given section without tab bar. */
  mode?: "characters" | "clues" | "scenes";
  onSaveCharacter: (
    name: string,
    payload: {
      description: string;
      voiceStyle: string;
      imageBackend?: string | null;
    }
  ) => Promise<void>;
  onUploadCharacterReference: (name: string, file: File) => Promise<void> | void;
  onRemoveCharacterReference?: (name: string) => Promise<void> | void;
  onUpdateClue: (name: string, updates: Partial<Clue>) => Promise<void>;
  onGenerateCharacter: (name: string) => void;
  onGenerateClue: (name: string) => void;
  onGenerateScene: (name: string) => void;
  onUploadClueReference?: (name: string, file: File) => Promise<void> | void;
  onUploadSceneReference?: (name: string, file: File) => Promise<void> | void;
  onRemoveClueReference?: (name: string) => Promise<void> | void;
  onRemoveSceneReference?: (name: string) => Promise<void> | void;
  onDeleteCharacter?: (name: string) => Promise<void> | void;
  onDeleteClue?: (name: string) => Promise<void> | void;
  onRenameCharacter?: (oldName: string, newName: string) => Promise<void> | void;
  onRenameClue?: (oldName: string, newName: string) => Promise<void> | void;
  onRenameScene?: (oldName: string, newName: string) => Promise<void> | void;
  onRestoreCharacterVersion?: () => Promise<void> | void;
  onRestoreClueVersion?: () => Promise<void> | void;
  generatingCharacterNames?: Set<string>;
  generatingClueNames?: Set<string>;
  generatingSceneNames?: Set<string>;
  /** ---- Scene 相關 ---- */
  onSaveScene: (
    name: string,
    payload: {
      description: string;
      imageBackend?: string | null;
    },
  ) => Promise<void>;
  onDeleteScene?: (name: string) => Promise<void> | void;
  onRestoreSceneVersion?: () => Promise<void> | void;
  /** Called when the user clicks "新增角色". */
  onAddCharacter?: () => void;
  /** Called when the user clicks "新增線索". */
  onAddClue?: () => void;
  /** Called when the user clicks "新增場景". */
  onAddScene?: () => void;
  /** AI 批次匯入後，通知父元件重新獲取資料 */
  onRefresh?: () => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------

type Tab = "characters" | "clues" | "scenes";
type BatchKind = "characters" | "clues" | "scenes";

const BATCH_LABELS: Record<BatchKind, string> = {
  characters: "角色",
  clues: "道具",
  scenes: "場景",
};

// ---------------------------------------------------------------------------
// LorebookGallery
// ---------------------------------------------------------------------------

export function LorebookGallery({
  projectName,
  characters,
  clues,
  scenes,
  mode,
  onSaveCharacter,
  onUploadCharacterReference,
  onRemoveCharacterReference,
  onUpdateClue,
  onGenerateCharacter,
  onGenerateClue,
  onGenerateScene,
  onUploadClueReference,
  onUploadSceneReference,
  onRemoveClueReference,
  onRemoveSceneReference,
  onDeleteCharacter,
  onDeleteClue,
  onRenameCharacter,
  onRenameClue,
  onRenameScene,
  onRestoreCharacterVersion,
  onRestoreClueVersion,
  generatingCharacterNames,
  generatingClueNames,
  generatingSceneNames,
  onSaveScene,
  onDeleteScene,
  onRestoreSceneVersion,
  onAddCharacter,
  onAddClue,
  onAddScene,
  onRefresh,
}: LorebookGalleryProps) {
  const confirm = useConfirm();
  const assistantPanelOpen = useAppStore((s) => s.assistantPanelOpen);
  const [expanded, setExpanded] = useState<Record<Tab, boolean>>(() => ({
    characters: mode === "characters" || !mode,
    clues: mode === "clues",
    scenes: mode === "scenes",
  }));

  const [extractingType, setExtractingType] = useState<"character" | "clue" | "scene" | null>(null);

  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    providersApi
      .getProviders()
      .then((res) => {
        if (!cancelled) setProviders(res.providers);
      })
      .catch((err) => {
        console.error("Failed to load providers in LorebookGallery:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const modelOptions = useMemo(() => buildMediaModelOptions(providers), [providers]);

  const gridClassName = useMemo(() => {
    return assistantPanelOpen
      ? "grid grid-cols-1 lg:grid-cols-2 gap-4"
      : "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4";
  }, [assistantPanelOpen]);

  useEffect(() => {
    if (mode) {
      setExpanded((prev) => ({ ...prev, [mode]: true }));
      // 在 DOM 渲染後平滑滾動到對應的 section
      setTimeout(() => {
        const el = document.getElementById(`section-${mode}`);
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    }
  }, [mode]);

  // Respond to agent-triggered scroll targets
  useScrollTarget("character");
  useScrollTarget("clue");

  const scrollTarget = useAppStore((s) => s.scrollTarget);
  useEffect(() => {
    if (!scrollTarget) return;
    if (scrollTarget.type === "character" && !expanded.characters) {
      setExpanded((prev) => ({ ...prev, characters: true }));
    } else if (scrollTarget.type === "clue" && !expanded.clues) {
      setExpanded((prev) => ({ ...prev, clues: true }));
    }
  }, [scrollTarget, expanded.characters, expanded.clues]);

  const charEntries = Object.entries(characters);
  const clueEntries = Object.entries(clues);
  const sceneEntries = Object.entries(scenes ?? {});
  const charCount = charEntries.length;
  const clueCount = clueEntries.length;
  const sceneCount = sceneEntries.length;

  const [batchBusy, setBatchBusy] = useState<BatchKind | null>(null);

  const runBatch = async (kind: BatchKind, force: boolean) => {
    if (batchBusy) return;
    setBatchBusy(kind);
    try {
      let res: { enqueued: string[]; skipped: { id: string; reason: string }[] };
      if (kind === "characters") {
        res = await API.batchGenerateCharacters(projectName, { force });
      } else if (kind === "clues") {
        res = await API.batchGenerateClues(projectName, { force });
      } else {
        res = await API.batchGenerateScenes(projectName, { force });
      }
      useAppStore.getState().pushToast(
        `已入隊 ${res.enqueued.length} 個${BATCH_LABELS[kind]}，略過 ${res.skipped.length}`,
        "success",
      );
    } catch (err) {
      useAppStore.getState().pushToast(
        `批次生成${BATCH_LABELS[kind]}失敗：${(err as Error).message}`,
        "error",
      );
    } finally {
      setBatchBusy(null);
    }
  };

  const isGeneratingCharacter = (name: string) =>
    generatingCharacterNames?.has(name) ?? false;
  const isGeneratingClue = (name: string) =>
    generatingClueNames?.has(name) ?? false;
  const isGeneratingScene = (name: string) =>
    generatingSceneNames?.has(name) ?? false;

  return (
    <div className="flex flex-col gap-6">
      {/* ---- Characters Accordion ---- */}
      <div className={`rounded-xl border transition-all duration-300 ${
        expanded.characters 
          ? "border-gray-700/60 bg-gray-900/20 shadow-lg shadow-black/10" 
          : "border-gray-800/40 bg-gray-900/5 hover:border-gray-800/80"
      }`}>
        <div
          id="section-characters"
          onClick={() => setExpanded(prev => ({ ...prev, characters: !prev.characters }))}
          className={`flex items-center justify-between cursor-pointer px-4 py-3.5 select-none transition-all duration-200 ${
            expanded.characters ? "bg-gray-800/40 border-b border-gray-800/40 rounded-t-xl" : "bg-gray-800/10 hover:bg-gray-800/20 rounded-xl"
          }`}
        >
          <div className="flex items-center gap-3">
            <User className="h-5 w-5 text-indigo-400" />
            <span className="font-semibold text-gray-200">角色 ({charCount})</span>
            <ChevronDown className={`h-4 w-4 text-gray-500 transition-transform duration-200 ${expanded.characters ? 'rotate-180' : ''}`} />
          </div>
        </div>

        {expanded.characters && (
          <div className="p-4 flex flex-col gap-4">
            {charCount === 0 ? (
              <div className="flex flex-col items-center justify-center gap-4 py-12">
                <EmptyState
                  icon={<User className="h-12 w-12 text-gray-600" />}
                  message="暫無角色，點選下方按鈕新增"
                />
                <div className="flex gap-2">
                  {onAddCharacter && <AddButton onClick={onAddCharacter} className="mx-0">新增角色</AddButton>}
                  {onAddCharacter && (
                    <button
                      type="button"
                      onClick={() => setExtractingType("character")}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/40 px-4 py-2 text-sm font-medium text-gray-400 hover:border-gray-500 hover:text-gray-200 transition-colors focus:outline-none"
                    >
                      <Sparkles className="h-4 w-4 text-indigo-400" />
                      AI 匯入角色
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  {onAddCharacter && <AddButton onClick={onAddCharacter} className="mx-0">新增角色</AddButton>}
                  {onAddCharacter && (
                    <button
                      type="button"
                      onClick={() => setExtractingType("character")}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/40 px-4 py-2 text-sm font-medium text-gray-400 hover:border-gray-500 hover:text-gray-200 transition-colors focus:outline-none"
                    >
                      <Sparkles className="h-4 w-4 text-indigo-400" />
                      AI 匯入角色
                    </button>
                  )}
                  <BatchButton
                    loading={batchBusy === "characters"}
                    disabled={batchBusy !== null}
                    onClick={() => void runBatch("characters", false)}
                  >
                    批次生成（缺圖）
                  </BatchButton>

                </div>
                <div className={gridClassName}>
                  {charEntries.map(([charName, character]) => (
                    <div id={`character-${charName}`} key={charName}>
                      <CharacterCard
                        name={charName}
                        character={character}
                        projectName={projectName}
                        onSave={onSaveCharacter}
                        onUploadReference={onUploadCharacterReference}
                        onRemoveReference={onRemoveCharacterReference}
                        onGenerate={onGenerateCharacter}
                        onDelete={onDeleteCharacter}
                        onRename={onRenameCharacter}
                        onRestoreVersion={onRestoreCharacterVersion}
                        generating={isGeneratingCharacter(charName)}
                        modelOptions={modelOptions}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ---- Clues Accordion ---- */}
      <div className={`rounded-xl border transition-all duration-300 ${
        expanded.clues 
          ? "border-gray-700/60 bg-gray-900/20 shadow-lg shadow-black/10" 
          : "border-gray-800/40 bg-gray-900/5 hover:border-gray-800/80"
      }`}>
        <div
          id="section-clues"
          onClick={() => setExpanded(prev => ({ ...prev, clues: !prev.clues }))}
          className={`flex items-center justify-between cursor-pointer px-4 py-3.5 select-none transition-all duration-200 ${
            expanded.clues ? "bg-gray-800/40 border-b border-gray-800/40 rounded-t-xl" : "bg-gray-800/10 hover:bg-gray-800/20 rounded-xl"
          }`}
        >
          <div className="flex items-center gap-3">
            <Puzzle className="h-5 w-5 text-indigo-400" />
            <span className="font-semibold text-gray-200">道具 ({clueCount})</span>
            <ChevronDown className={`h-4 w-4 text-gray-500 transition-transform duration-200 ${expanded.clues ? 'rotate-180' : ''}`} />
          </div>
        </div>

        {expanded.clues && (
          <div className="p-4 flex flex-col gap-4">
            {clueCount === 0 ? (
              <div className="flex flex-col items-center justify-center gap-4 py-12">
                <EmptyState
                  icon={<Puzzle className="h-12 w-12 text-gray-600" />}
                  message="暫無道具，點選下方按鈕新增"
                />
                <div className="flex gap-2">
                  {onAddClue && <AddButton onClick={onAddClue} className="mx-0">新增道具</AddButton>}
                  {onAddClue && (
                    <button
                      type="button"
                      onClick={() => setExtractingType("clue")}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/40 px-4 py-2 text-sm font-medium text-gray-400 hover:border-gray-500 hover:text-gray-200 transition-colors focus:outline-none"
                    >
                      <Sparkles className="h-4 w-4 text-indigo-400" />
                      AI 匯入道具
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  {onAddClue && <AddButton onClick={onAddClue} className="mx-0">新增道具</AddButton>}
                  {onAddClue && (
                    <button
                      type="button"
                      onClick={() => setExtractingType("clue")}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/40 px-4 py-2 text-sm font-medium text-gray-400 hover:border-gray-500 hover:text-gray-200 transition-colors focus:outline-none"
                    >
                      <Sparkles className="h-4 w-4 text-indigo-400" />
                      AI 匯入道具
                    </button>
                  )}
                  <BatchButton
                    loading={batchBusy === "clues"}
                    disabled={batchBusy !== null}
                    onClick={() => void runBatch("clues", false)}
                  >
                    批次生成（缺圖）
                  </BatchButton>

                </div>
                <div className={gridClassName}>
                  {clueEntries.map(([clueName, clue]) => (
                    <div id={`clue-${clueName}`} key={clueName}>
                      <ClueCard
                        name={clueName}
                        clue={clue}
                        projectName={projectName}
                        onSave={(n, payload) =>
                          onUpdateClue(n, {
                            description: payload.description,
                            image_backend: payload.imageBackend,
                          })
                        }
                        onGenerate={onGenerateClue}
                        onUploadReference={onUploadClueReference}
                        onRemoveReference={onRemoveClueReference}
                        onDelete={onDeleteClue}
                        onRename={onRenameClue}
                        onRestoreVersion={onRestoreClueVersion}
                        generating={isGeneratingClue(clueName)}
                        modelOptions={modelOptions}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ---- Scenes Accordion ---- */}
      <div className={`rounded-xl border transition-all duration-300 ${
        expanded.scenes 
          ? "border-gray-700/60 bg-gray-900/20 shadow-lg shadow-black/10" 
          : "border-gray-800/40 bg-gray-900/5 hover:border-gray-800/80"
      }`}>
        <div
          id="section-scenes"
          onClick={() => setExpanded(prev => ({ ...prev, scenes: !prev.scenes }))}
          className={`flex items-center justify-between cursor-pointer px-4 py-3.5 select-none transition-all duration-200 ${
            expanded.scenes ? "bg-gray-800/40 border-b border-gray-800/40 rounded-t-xl" : "bg-gray-800/10 hover:bg-gray-800/20 rounded-xl"
          }`}
        >
          <div className="flex items-center gap-3">
            <Mountain className="h-5 w-5 text-indigo-400" />
            <span className="font-semibold text-gray-200">場景 ({sceneCount})</span>
            <ChevronDown className={`h-4 w-4 text-gray-500 transition-transform duration-200 ${expanded.scenes ? 'rotate-180' : ''}`} />
          </div>
        </div>

        {expanded.scenes && (
          <div className="p-4 flex flex-col gap-4">
            {sceneCount === 0 ? (
              <div className="flex flex-col items-center justify-center gap-4 py-12">
                <EmptyState
                  icon={<Mountain className="h-12 w-12 text-gray-600" />}
                  message="暫無場景，點選下方按鈕新增"
                />
                <div className="flex gap-2">
                  {onAddScene && <AddButton onClick={onAddScene} className="mx-0">新增場景</AddButton>}
                  {onAddScene && (
                    <button
                      type="button"
                      onClick={() => setExtractingType("scene")}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/40 px-4 py-2 text-sm font-medium text-gray-400 hover:border-gray-500 hover:text-gray-200 transition-colors focus:outline-none"
                    >
                      <Sparkles className="h-4 w-4 text-indigo-400" />
                      AI 匯入場景
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  {onAddScene && <AddButton onClick={onAddScene} className="mx-0">新增場景</AddButton>}
                  {onAddScene && (
                    <button
                      type="button"
                      onClick={() => setExtractingType("scene")}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/40 px-4 py-2 text-sm font-medium text-gray-400 hover:border-gray-500 hover:text-gray-200 transition-colors focus:outline-none"
                    >
                      <Sparkles className="h-4 w-4 text-indigo-400" />
                      AI 匯入場景
                    </button>
                  )}
                  <BatchButton
                    loading={batchBusy === "scenes"}
                    disabled={batchBusy !== null}
                    onClick={() => void runBatch("scenes", false)}
                  >
                    批次生成（缺圖）
                  </BatchButton>

                </div>
                <div className={gridClassName}>
                  {sceneEntries.map(([sceneName, scene]) => (
                    <div id={`scene-${sceneName}`} key={sceneName}>
                      <SceneCard
                        name={sceneName}
                        scene={scene}
                        projectName={projectName}
                        onSave={onSaveScene}
                        onGenerate={onGenerateScene}
                        onUploadReference={onUploadSceneReference}
                        onRemoveReference={onRemoveSceneReference}
                        onDelete={onDeleteScene}
                        onRename={onRenameScene}
                        onRestoreVersion={onRestoreSceneVersion}
                        generating={isGeneratingScene(sceneName)}
                        modelOptions={modelOptions}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <LorebookAIExtractModal
        isOpen={extractingType !== null}
        onClose={() => setExtractingType(null)}
        projectName={projectName}
        entityType={extractingType ?? "character"}
        modelOptions={modelOptions}
        onImported={() => { void onRefresh?.(); }}
      />
    </div>
  );
}

function BatchButton({
  onClick,
  children,
  loading,
  disabled,
  variant = "primary",
}: {
  onClick: () => void;
  children: React.ReactNode;
  loading?: boolean;
  disabled?: boolean;
  variant?: "primary" | "warning";
}) {
  const cls =
    variant === "warning"
      ? "border-amber-600/40 text-amber-400 hover:border-amber-500 hover:bg-amber-500/10"
      : "border-indigo-500/40 text-indigo-300 hover:border-indigo-400 hover:bg-indigo-500/10";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}
    >
      {loading ? (
        <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border border-current border-t-transparent" />
      ) : (
        <Sparkles className="h-4 w-4" />
      )}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Internal sub-components
// ---------------------------------------------------------------------------

function EmptyState({
  icon,
  message,
}: {
  icon: React.ReactNode;
  message: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-gray-500">
      {icon}
      <p className="text-sm">{message}</p>
    </div>
  );
}

function AddButton({
  onClick,
  children,
  className = "mx-auto",
}: {
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-400 hover:border-gray-500 hover:text-gray-200 transition-colors ${className}`}
    >
      <Plus className="h-4 w-4" />
      {children}
    </button>
  );
}
