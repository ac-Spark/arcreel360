import { useState, useCallback, useMemo } from "react";
import { Route, Switch, Redirect, useLocation } from "wouter";
import { useProjectsStore } from "@/stores/projects-store";
import { useAppStore } from "@/stores/app-store";
import { useTasksStore } from "@/stores/tasks-store";
import { LorebookGallery } from "./lorebook/LorebookGallery";
import { TimelineCanvas } from "./timeline/TimelineCanvas";
import { OverviewCanvas } from "./OverviewCanvas";
import { SourceFileViewer } from "./SourceFileViewer";
import { AddCharacterForm } from "./lorebook/AddCharacterForm";
import { AddClueForm } from "./lorebook/AddClueForm";
import { API } from "@/api";
import { useVideoDurationOptions } from "@/hooks/useVideoDurationOptions";
import { resolveEpisodeContentMode } from "@/utils/content-mode";
import { buildEntityRevisionKey } from "@/utils/project-changes";
import type { Clue, TaskItem } from "@/types";

// ---------------------------------------------------------------------------
// StudioCanvasRouter — reads Zustand store data and renders the correct
// canvas view based on the nested route within /app/projects/:projectName.
// ---------------------------------------------------------------------------

const ACTIVE_TASK_STATUSES = new Set<TaskItem["status"]>(["queued", "running"]);

interface GeneratingResources {
  characterNames: Set<string>;
  clueNames: Set<string>;
  storyboardIds: Set<string>;
  videoIds: Set<string>;
}

function collectGeneratingResources(
  tasks: TaskItem[],
  projectName: string | null | undefined,
): GeneratingResources {
  const resources: GeneratingResources = {
    characterNames: new Set<string>(),
    clueNames: new Set<string>(),
    storyboardIds: new Set<string>(),
    videoIds: new Set<string>(),
  };

  for (const task of tasks) {
    if (
      task.project_name !== projectName ||
      !ACTIVE_TASK_STATUSES.has(task.status)
    ) {
      continue;
    }

    switch (task.task_type) {
      case "character":
        resources.characterNames.add(task.resource_id);
        break;
      case "clue":
        resources.clueNames.add(task.resource_id);
        break;
      case "storyboard":
        resources.storyboardIds.add(task.resource_id);
        break;
      case "video":
        resources.videoIds.add(task.resource_id);
        break;
    }
  }

  return resources;
}

export function StudioCanvasRouter() {
  const { currentProjectData, currentProjectName, currentScripts } =
    useProjectsStore();

  const [addingCharacter, setAddingCharacter] = useState(false);
  const [addingClue, setAddingClue] = useState(false);

  const durationOptions = useVideoDurationOptions(currentProjectData?.video_backend);

  // 從任務佇列派生 loading 狀態（替代本地 state）
  const tasks = useTasksStore((s) => s.tasks);
  const generatingResources = useMemo(
    () => collectGeneratingResources(tasks, currentProjectName),
    [tasks, currentProjectName],
  );

  // 重新整理專案資料
  const refreshProject = useCallback(async (invalidateKeys: string[] = []) => {
    if (!currentProjectName) return;
    try {
      const res = await API.getProject(currentProjectName);
      useProjectsStore.getState().setCurrentProject(
        currentProjectName,
        res.project,
        res.scripts ?? {},
        res.asset_fingerprints,
      );
      if (invalidateKeys.length > 0) {
        useAppStore.getState().invalidateEntities(invalidateKeys);
      }
    } catch {
      // 靜默失敗
    }
  }, [currentProjectName]);

  // ---- Timeline action callbacks ----
  // These receive scriptFile from TimelineCanvas so they always use the active episode's script.
  const handleUpdatePrompt = useCallback(async (segmentId: string, field: string, value: unknown, scriptFile?: string) => {
    if (!currentProjectName) return;
    const activeScript = scriptFile ? currentScripts?.[scriptFile] : undefined;
    const mode = resolveEpisodeContentMode(activeScript, currentProjectData?.content_mode);
    try {
      if (mode === "drama") {
        await API.updateScene(currentProjectName, segmentId, scriptFile ?? "", { [field]: value });
      } else {
        await API.updateSegment(currentProjectName, segmentId, { script_file: scriptFile, [field]: value });
      }
      await refreshProject();
    } catch (err) {
      useAppStore.getState().pushToast(`更新 Prompt 失敗: ${(err as Error).message}`, "error");
    }
  }, [currentProjectName, currentProjectData, currentScripts, refreshProject]);

  const handleGenerateStoryboard = useCallback(async (segmentId: string, scriptFile?: string) => {
    if (!currentProjectName || !currentScripts) return;
    const resolvedFile = scriptFile ?? Object.keys(currentScripts)[0];
    if (!resolvedFile) return;
    const script = currentScripts[resolvedFile];
    if (!script) return;
    const segments = ("segments" in script ? script.segments : undefined) ??
      ("scenes" in script ? script.scenes : undefined) ?? [];
    const seg = segments.find((s) => {
      const id = "segment_id" in s ? s.segment_id : (s as { scene_id?: string }).scene_id ?? "";
      return id === segmentId;
    });
    const prompt = seg?.image_prompt ?? "";
    try {
      await API.generateStoryboard(currentProjectName, segmentId, prompt as string | Record<string, unknown>, resolvedFile);
      useAppStore.getState().pushToast(`已提交分鏡「${segmentId}」生成任務`, "success");
    } catch (err) {
      useAppStore.getState().pushToast(`生成分鏡失敗: ${(err as Error).message}`, "error");
    }
  }, [currentProjectName, currentScripts]);

  const handleGenerateVideo = useCallback(async (segmentId: string, scriptFile?: string) => {
    if (!currentProjectName || !currentScripts) return;
    const resolvedFile = scriptFile ?? Object.keys(currentScripts)[0];
    if (!resolvedFile) return;
    const script = currentScripts[resolvedFile];
    if (!script) return;
    const segments = ("segments" in script ? script.segments : undefined) ??
      ("scenes" in script ? script.scenes : undefined) ?? [];
    const seg = segments.find((s) => {
      const id = "segment_id" in s ? s.segment_id : (s as { scene_id?: string }).scene_id ?? "";
      return id === segmentId;
    });
    const prompt = seg?.video_prompt ?? "";
    const duration = seg?.duration_seconds ?? 4;
    try {
      await API.generateVideo(currentProjectName, segmentId, prompt as string | Record<string, unknown>, resolvedFile, duration);
      useAppStore.getState().pushToast(`已提交影片「${segmentId}」生成任務`, "success");
    } catch (err) {
      useAppStore.getState().pushToast(`生成影片失敗: ${(err as Error).message}`, "error");
    }
  }, [currentProjectName, currentScripts]);

  // ---- Character CRUD callbacks ----
  const handleSaveCharacter = useCallback(async (
    name: string,
    payload: {
      description: string;
      voiceStyle: string;
      referenceFile?: File | null;
    },
  ) => {
    if (!currentProjectName) return;
    try {
      await API.updateCharacter(currentProjectName, name, {
        description: payload.description,
        voice_style: payload.voiceStyle,
      });

      if (payload.referenceFile) {
        await API.uploadFile(
          currentProjectName,
          "character_ref",
          payload.referenceFile,
          name,
        );
      }

      await refreshProject(
        payload.referenceFile
          ? [buildEntityRevisionKey("character", name)]
          : [],
      );
      useAppStore.getState().pushToast(`角色「${name}」已更新`, "success");
    } catch (err) {
      useAppStore.getState().pushToast(`更新角色失敗: ${(err as Error).message}`, "error");
    }
  }, [currentProjectName, refreshProject]);

  const handleGenerateCharacter = useCallback(async (name: string) => {
    if (!currentProjectName) return;
    try {
      await API.generateCharacter(
        currentProjectName,
        name,
        currentProjectData?.characters?.[name]?.description ?? "",
      );
      useAppStore
        .getState()
        .pushToast(`角色「${name}」生成任務已提交`, "success");
    } catch (err) {
      useAppStore.getState().pushToast(`提交失敗: ${(err as Error).message}`, "error");
    }
  }, [currentProjectName, currentProjectData]);

  const handleAddCharacterSubmit = useCallback(async (
    name: string,
    description: string,
    voiceStyle: string,
    referenceFile?: File | null,
  ) => {
    if (!currentProjectName) return;
    try {
      await API.addCharacter(currentProjectName, name, description, voiceStyle);

      if (referenceFile) {
        await API.uploadFile(currentProjectName, "character_ref", referenceFile, name);
      }

      await refreshProject(
        referenceFile
          ? [buildEntityRevisionKey("character", name)]
          : [],
      );
      setAddingCharacter(false);
      useAppStore.getState().pushToast(`角色「${name}」已新增`, "success");
    } catch (err) {
      useAppStore.getState().pushToast(`新增失敗: ${(err as Error).message}`, "error");
    }
  }, [currentProjectName, refreshProject]);

  // ---- Clue CRUD callbacks ----
  const handleUpdateClue = useCallback(async (name: string, updates: Partial<Clue>) => {
    if (!currentProjectName) return;
    try {
      await API.updateClue(currentProjectName, name, updates);
      await refreshProject();
    } catch (err) {
      useAppStore.getState().pushToast(`更新道具失敗: ${(err as Error).message}`, "error");
    }
  }, [currentProjectName, refreshProject]);

  const handleGenerateClue = useCallback(async (name: string) => {
    if (!currentProjectName) return;
    try {
      await API.generateClue(
        currentProjectName,
        name,
        currentProjectData?.clues?.[name]?.description ?? "",
      );
      useAppStore
        .getState()
        .pushToast(`道具「${name}」生成任務已提交`, "success");
    } catch (err) {
      useAppStore.getState().pushToast(`提交失敗: ${(err as Error).message}`, "error");
    }
  }, [currentProjectName, currentProjectData]);

  const handleDeleteCharacter = useCallback(async (name: string) => {
    if (!currentProjectName) return;
    try {
      await API.deleteCharacter(currentProjectName, name);
      await refreshProject();
      useAppStore.getState().pushToast(`角色「${name}」已刪除`, "success");
    } catch (err) {
      useAppStore.getState().pushToast(`刪除角色失敗: ${(err as Error).message}`, "error");
    }
  }, [currentProjectName, refreshProject]);

  const handleDeleteClue = useCallback(async (name: string) => {
    if (!currentProjectName) return;
    try {
      await API.deleteClue(currentProjectName, name);
      await refreshProject();
      useAppStore.getState().pushToast(`道具「${name}」已刪除`, "success");
    } catch (err) {
      useAppStore.getState().pushToast(`刪除失敗: ${(err as Error).message}`, "error");
    }
  }, [currentProjectName, refreshProject]);

  const handleRenameCharacter = useCallback(async (oldName: string, newName: string) => {
    if (!currentProjectName) return;
    try {
      const res = await API.renameCharacter(currentProjectName, oldName, newName);
      await refreshProject([buildEntityRevisionKey("character", newName)]);
      useAppStore.getState().pushToast(
        `角色「${oldName}」→「${newName}」（更新 ${res.scripts_updated} 份劇本）`,
        "success",
      );
    } catch (err) {
      useAppStore.getState().pushToast(`改名失敗: ${(err as Error).message}`, "error");
    }
  }, [currentProjectName, refreshProject]);

  const handleRenameClue = useCallback(async (oldName: string, newName: string) => {
    if (!currentProjectName) return;
    try {
      const res = await API.renameClue(currentProjectName, oldName, newName);
      await refreshProject([buildEntityRevisionKey("clue", newName)]);
      useAppStore.getState().pushToast(
        `道具「${oldName}」→「${newName}」（更新 ${res.scripts_updated} 份劇本）`,
        "success",
      );
    } catch (err) {
      useAppStore.getState().pushToast(`改名失敗: ${(err as Error).message}`, "error");
    }
  }, [currentProjectName, refreshProject]);

  const handleAddClueSubmit = useCallback(async (name: string, clueType: string, description: string, importance: string) => {
    if (!currentProjectName) return;
    try {
      await API.addClue(currentProjectName, name, clueType, description, importance);
      await refreshProject();
      setAddingClue(false);
      useAppStore.getState().pushToast(`道具「${name}」已新增`, "success");
    } catch (err) {
      useAppStore.getState().pushToast(`新增失敗: ${(err as Error).message}`, "error");
    }
  }, [currentProjectName, refreshProject]);

  const handleRestoreAsset = useCallback(async () => {
    await refreshProject();
  }, [refreshProject]);

  const [location] = useLocation();

  if (!currentProjectName) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        載入中...
      </div>
    );
  }

  return (
    <Switch>
      <Route path="/">
        <OverviewCanvas
          projectName={currentProjectName}
          projectData={currentProjectData}
        />
      </Route>

      <Route path="/lorebook">
        <Redirect to="/characters" />
      </Route>

      {/* Characters & Clues share one LorebookGallery to avoid remount flash */}
      {(location === "/characters" || location === "/clues") && (
        <div className="p-4">
          <LorebookGallery
            projectName={currentProjectName}
            characters={currentProjectData?.characters ?? {}}
            clues={currentProjectData?.clues ?? {}}
            mode={location === "/clues" ? "clues" : "characters"}
            onSaveCharacter={handleSaveCharacter}
            onUpdateClue={handleUpdateClue}
            onGenerateCharacter={handleGenerateCharacter}
            onGenerateClue={handleGenerateClue}
            onDeleteCharacter={handleDeleteCharacter}
            onDeleteClue={handleDeleteClue}
            onRenameCharacter={handleRenameCharacter}
            onRenameClue={handleRenameClue}
            onRestoreCharacterVersion={handleRestoreAsset}
            onRestoreClueVersion={handleRestoreAsset}
            generatingCharacterNames={generatingResources.characterNames}
            generatingClueNames={generatingResources.clueNames}
            onAddCharacter={() => setAddingCharacter(true)}
            onAddClue={() => setAddingClue(true)}
          />
          {addingCharacter && (
            <AddCharacterForm
              onSubmit={handleAddCharacterSubmit}
              onCancel={() => setAddingCharacter(false)}
            />
          )}
          {addingClue && (
            <AddClueForm
              onSubmit={handleAddClueSubmit}
              onCancel={() => setAddingClue(false)}
            />
          )}
        </div>
      )}

      <Route path="/source/:filename">
        {(params) => (
          <SourceFileViewer
            projectName={currentProjectName}
            filename={decodeURIComponent(params.filename)}
          />
        )}
      </Route>

      <Route path="/episodes/:episodeId">
        {(params) => {
          const epNum = parseInt(params.episodeId, 10);
          const episode = currentProjectData?.episodes?.find(
            (e) => e.episode === epNum,
          );
          const scriptFile = episode?.script_file?.replace(/^scripts\//, "");
          const script = scriptFile
            ? (currentScripts[scriptFile] ?? null)
            : null;

          const hasDraft = Boolean(episode);

          return (
            <TimelineCanvas
              key={epNum}
              projectName={currentProjectName}
              episode={epNum}
              episodeTitle={episode?.title}
              hasDraft={hasDraft}
              episodeScript={script}
              scriptFile={scriptFile ?? undefined}
              projectData={currentProjectData}
              durationOptions={durationOptions}
              onUpdatePrompt={handleUpdatePrompt}
              onGenerateStoryboard={handleGenerateStoryboard}
              onGenerateVideo={handleGenerateVideo}
              onRestoreStoryboard={handleRestoreAsset}
              onRestoreVideo={handleRestoreAsset}
              generatingStoryboardIds={generatingResources.storyboardIds}
              generatingVideoIds={generatingResources.videoIds}
            />
          );
        }}
      </Route>
    </Switch>
  );
}
