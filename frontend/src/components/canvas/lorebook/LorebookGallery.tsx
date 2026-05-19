import { useState, useEffect } from "react";
import { User, Puzzle, Mountain, Plus, Sparkles } from "lucide-react";
import { API } from "@/api";
import { CharacterCard } from "./CharacterCard";
import { ClueCard } from "./ClueCard";
import { SceneCard } from "./SceneCard";
import { useScrollTarget } from "@/hooks/useScrollTarget";
import { useConfirm } from "@/hooks/useConfirm";
import { useAppStore } from "@/stores/app-store";
import type { Character, Clue, Scene } from "@/types";

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
      referenceFile?: File | null;
    }
  ) => Promise<void>;
  onUpdateClue: (name: string, updates: Partial<Clue>) => void;
  onGenerateCharacter: (name: string) => void;
  onGenerateClue: (name: string) => void;
  onToggleCharacterUseUploaded?: (name: string, value: boolean) => Promise<void> | void;
  onToggleClueUseUploaded?: (name: string, value: boolean) => Promise<void> | void;
  onUploadClueReference?: (name: string, file: File) => Promise<void> | void;
  onDeleteCharacter?: (name: string) => Promise<void> | void;
  onDeleteClue?: (name: string) => Promise<void> | void;
  onRenameCharacter?: (oldName: string, newName: string) => Promise<void> | void;
  onRenameClue?: (oldName: string, newName: string) => Promise<void> | void;
  onRestoreCharacterVersion?: () => Promise<void> | void;
  onRestoreClueVersion?: () => Promise<void> | void;
  generatingCharacterNames?: Set<string>;
  generatingClueNames?: Set<string>;
  /** ---- Scene 相關 ---- */
  onSaveScene: (
    name: string,
    payload: { description: string; referenceFile?: File | null },
  ) => Promise<void>;
  onToggleSceneUseUploaded: (name: string, value: boolean) => Promise<void> | void;
  onDeleteScene?: (name: string) => Promise<void> | void;
  /** Called when the user clicks "新增角色". */
  onAddCharacter?: () => void;
  /** Called when the user clicks "新增線索". */
  onAddClue?: () => void;
  /** Called when the user clicks "新增場景". */
  onAddScene?: () => void;
}

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------

type Tab = "characters" | "clues" | "scenes";

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
  onUpdateClue,
  onGenerateCharacter,
  onGenerateClue,
  onToggleCharacterUseUploaded,
  onToggleClueUseUploaded,
  onUploadClueReference,
  onDeleteCharacter,
  onDeleteClue,
  onRenameCharacter,
  onRenameClue,
  onRestoreCharacterVersion,
  onRestoreClueVersion,
  generatingCharacterNames,
  generatingClueNames,
  onSaveScene,
  onToggleSceneUseUploaded,
  onDeleteScene,
  onAddCharacter,
  onAddClue,
  onAddScene,
}: LorebookGalleryProps) {
  const confirm = useConfirm();
  const [activeTab, setActiveTab] = useState<Tab>(mode ?? "characters");
  const showTabs = !mode;

  // Sync activeTab when mode prop changes (avoids stale tab on route switch)
  useEffect(() => {
    if (mode) setActiveTab(mode);
  }, [mode]);

  // Respond to agent-triggered scroll targets
  useScrollTarget("character");
  useScrollTarget("clue");

  // Auto-switch tab when scroll target points to the other tab
  const scrollTarget = useAppStore((s) => s.scrollTarget);
  useEffect(() => {
    if (!scrollTarget) return;
    if (scrollTarget.type === "character" && activeTab !== "characters") {
      setActiveTab("characters");
    } else if (scrollTarget.type === "clue" && activeTab !== "clues") {
      setActiveTab("clues");
    }
  }, [scrollTarget, activeTab]);

  const charEntries = Object.entries(characters);
  const clueEntries = Object.entries(clues);
  const sceneEntries = Object.entries(scenes ?? {});
  const charCount = charEntries.length;
  const clueCount = clueEntries.length;
  const sceneCount = sceneEntries.length;

  const [batchBusy, setBatchBusy] = useState<"characters" | "clues" | null>(null);

  const runBatch = async (kind: "characters" | "clues", force: boolean) => {
    if (batchBusy) return;
    const label = kind === "characters" ? "角色" : "道具";
    setBatchBusy(kind);
    try {
      const res = kind === "characters"
        ? await API.batchGenerateCharacters(projectName, { force })
        : await API.batchGenerateClues(projectName, { force });
      useAppStore.getState().pushToast(
        `已入隊 ${res.enqueued.length} 個${label}，略過 ${res.skipped.length}`,
        "success",
      );
    } catch (err) {
      useAppStore.getState().pushToast(
        `批次生成${label}失敗：${(err as Error).message}`,
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

  return (
    <div className="flex flex-col gap-4">
      {/* ---- Tab bar (hidden when mode is specified) ---- */}
      {showTabs && (
        <div className="flex border-b border-gray-800">
          <TabButton
            active={activeTab === "characters"}
            onClick={() => setActiveTab("characters")}
          >
            角色 ({charCount})
          </TabButton>
          <TabButton
            active={activeTab === "clues"}
            onClick={() => setActiveTab("clues")}
          >
            道具 ({clueCount})
          </TabButton>
          <TabButton
            active={activeTab === "scenes"}
            onClick={() => setActiveTab("scenes")}
          >
            場景 ({sceneCount})
          </TabButton>
        </div>
      )}

      {/* ---- Characters tab ---- */}
      {activeTab === "characters" && (
        <>
          {charCount === 0 ? (
            <EmptyState
              icon={<User className="h-12 w-12 text-gray-600" />}
              message="暫無角色，點選下方按鈕新增"
            />
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {charEntries.map(([charName, character]) => (
                <div id={`character-${charName}`} key={charName}>
                  <CharacterCard
                    name={charName}
                    character={character}
                    projectName={projectName}
                    onSave={onSaveCharacter}
                    onToggleUseUploaded={onToggleCharacterUseUploaded}
                    onGenerate={onGenerateCharacter}
                    onDelete={onDeleteCharacter}
                    onRename={onRenameCharacter}
                    onRestoreVersion={onRestoreCharacterVersion}
                    generating={isGeneratingCharacter(charName)}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-2">
            {onAddCharacter && (
              <AddButton onClick={onAddCharacter}>新增角色</AddButton>
            )}
            {charCount > 0 && (
              <>
                <BatchButton
                  loading={batchBusy === "characters"}
                  disabled={batchBusy !== null}
                  onClick={() => void runBatch("characters", false)}
                >
                  批次生成（缺圖）
                </BatchButton>
                <BatchButton
                  variant="warning"
                  loading={batchBusy === "characters"}
                  disabled={batchBusy !== null}
                  onClick={async () => {
                    if (await confirm({ message: "會覆寫所有角色設計圖。確定？", danger: true })) {
                      void runBatch("characters", true);
                    }
                  }}
                >
                  全部重生
                </BatchButton>
              </>
            )}
          </div>
        </>
      )}

      {/* ---- Clues tab ---- */}
      {activeTab === "clues" && (
        <>
          {clueCount === 0 ? (
            <EmptyState
              icon={<Puzzle className="h-12 w-12 text-gray-600" />}
              message="暫無道具，點選下方按鈕新增"
            />
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {clueEntries.map(([clueName, clue]) => (
                <div id={`clue-${clueName}`} key={clueName}>
                  <ClueCard
                    name={clueName}
                    clue={clue}
                    projectName={projectName}
                    onUpdate={onUpdateClue}
                    onGenerate={onGenerateClue}
                    onUploadReference={onUploadClueReference}
                    onToggleUseUploaded={onToggleClueUseUploaded}
                    onDelete={onDeleteClue}
                    onRename={onRenameClue}
                    onRestoreVersion={onRestoreClueVersion}
                    generating={isGeneratingClue(clueName)}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-2">
            {onAddClue && <AddButton onClick={onAddClue}>新增道具</AddButton>}
            {clueCount > 0 && (
              <>
                <BatchButton
                  loading={batchBusy === "clues"}
                  disabled={batchBusy !== null}
                  onClick={() => void runBatch("clues", false)}
                >
                  批次生成（缺圖）
                </BatchButton>
                <BatchButton
                  variant="warning"
                  loading={batchBusy === "clues"}
                  disabled={batchBusy !== null}
                  onClick={async () => {
                    if (await confirm({ message: "會覆寫所有道具設計圖。確定？", danger: true })) {
                      void runBatch("clues", true);
                    }
                  }}
                >
                  全部重生
                </BatchButton>
              </>
            )}
          </div>
        </>
      )}

      {/* ---- Scenes tab ---- */}
      {activeTab === "scenes" && (
        <>
          {sceneCount === 0 ? (
            <EmptyState
              icon={<Mountain className="h-12 w-12 text-gray-600" />}
              message="暫無場景，點選下方按鈕新增"
            />
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {sceneEntries.map(([sceneName, scene]) => (
                <div id={`scene-${sceneName}`} key={sceneName}>
                  <SceneCard
                    name={sceneName}
                    scene={scene}
                    projectName={projectName}
                    onSave={onSaveScene}
                    onToggleUseUploaded={onToggleSceneUseUploaded}
                    onDelete={onDeleteScene}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-2">
            {onAddScene && <AddButton onClick={onAddScene}>新增場景</AddButton>}
          </div>
        </>
      )}
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

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium transition-colors ${active
          ? "border-b-2 border-indigo-500 text-white"
          : "text-gray-400 hover:text-gray-200"
        }`}
    >
      {children}
    </button>
  );
}

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
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-auto flex items-center gap-1.5 rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-400 hover:border-gray-500 hover:text-gray-200 transition-colors"
    >
      <Plus className="h-4 w-4" />
      {children}
    </button>
  );
}
