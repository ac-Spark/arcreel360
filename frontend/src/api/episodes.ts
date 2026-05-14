/**
 * 集數工作流：建立/更新/刪除集、片段、場景、生成劇本/分鏡/影片 等。
 */

import type { EpisodeMeta, EpisodeScript, ProjectData } from "@/types";
import { withScriptFileQuery , getApi} from "./_http";
import type { SuccessResponse } from "./types";

export const episodesApi = {
  async updateEpisode(
    name: string,
    episode: number,
    updates: { title?: string },
  ): Promise<{ success: boolean }> {
    return getApi().request(
      `/projects/${encodeURIComponent(name)}/episodes/${episode}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      },
    );
  },

  async createEpisode(
    name: string,
    body: { episode?: number; title?: string } = {},
  ): Promise<{ success: boolean; episode: EpisodeMeta; project: ProjectData }> {
    return getApi().request(`/projects/${encodeURIComponent(name)}/episodes`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  // ==================== 批次生成 ====================

  async batchGenerateStoryboards(
    name: string,
    body: { script_file: string; ids?: string[] | null; force?: boolean },
  ): Promise<{ enqueued: string[]; skipped: { id: string; reason: string }[] }> {
    return getApi().request(
      `/projects/${encodeURIComponent(name)}/generate/storyboards/batch`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },

  async batchGenerateVideos(
    name: string,
    body: { script_file: string; ids?: string[] | null; force?: boolean },
  ): Promise<{ enqueued: string[]; skipped: { id: string; reason: string }[] }> {
    return getApi().request(
      `/projects/${encodeURIComponent(name)}/generate/videos/batch`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },

  async batchGenerateCharacters(
    name: string,
    body: { names?: string[] | null; force?: boolean } = {},
  ): Promise<{ enqueued: string[]; skipped: { id: string; reason: string }[] }> {
    return getApi().request(
      `/projects/${encodeURIComponent(name)}/generate/characters/batch`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },

  async batchGenerateClues(
    name: string,
    body: { names?: string[] | null; force?: boolean } = {},
  ): Promise<{ enqueued: string[]; skipped: { id: string; reason: string }[] }> {
    return getApi().request(
      `/projects/${encodeURIComponent(name)}/generate/clues/batch`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },

  // ==================== 集數工作流 ====================

  async composeEpisode(
    name: string,
    episode: number,
  ): Promise<{ output_path: string; stdout_tail: string; duration_seconds: number }> {
    return getApi().request(
      `/projects/${encodeURIComponent(name)}/episodes/${episode}/compose`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },

  async generateEpisodeScript(
    name: string,
    episode: number,
  ): Promise<{ script_file: string; segments_count: number }> {
    return getApi().request(
      `/projects/${encodeURIComponent(name)}/episodes/${episode}/script`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },

  async preprocessEpisode(
    name: string,
    episode: number,
  ): Promise<{ step1_path: string; content_mode: string }> {
    return getApi().request(
      `/projects/${encodeURIComponent(name)}/episodes/${episode}/preprocess`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },

  async addEpisodeSegment(
    name: string,
    episode: number,
  ): Promise<{ segment: unknown; segments_count: number }> {
    return getApi().request(
      `/projects/${encodeURIComponent(name)}/episodes/${episode}/segments`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },

  async addEpisodeScene(
    name: string,
    episode: number,
  ): Promise<{ scene: unknown; scenes_count: number }> {
    return getApi().request(
      `/projects/${encodeURIComponent(name)}/episodes/${episode}/scenes`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },

  /** 依傳入的集數順序重設顯示順序（後端寫到每個 episode 的 ``order`` 欄位）。 */
  async reorderEpisodes(
    name: string,
    episodeNumbers: number[],
  ): Promise<{ success: boolean; project: ProjectData }> {
    return getApi().request(
      `/projects/${encodeURIComponent(name)}/episodes/order`,
      { method: "PATCH", body: JSON.stringify({ episodes: episodeNumbers }) },
    );
  },

  /** 刪除一整集（劇本檔、預處理草稿、分鏡/影片/縮圖、版本檔、合成輸出），並從 project.json 移除。 */
  async deleteEpisode(
    name: string,
    episode: number,
  ): Promise<{
    success: boolean;
    episode: number;
    removed: string[];
    project: ProjectData;
  }> {
    return getApi().request(
      `/projects/${encodeURIComponent(name)}/episodes/${episode}`,
      { method: "DELETE" },
    );
  },

  /** 清空指定劇集的劇本內容（重置為空骨架），保留劇集條目與預處理草稿。 */
  async resetEpisodeScript(
    name: string,
    episode: number,
  ): Promise<{ success: boolean; episode: number; content_mode: string }> {
    return getApi().request(
      `/projects/${encodeURIComponent(name)}/episodes/${episode}/script`,
      { method: "DELETE" },
    );
  },

  /** 刪除說書模式劇本中的一個片段。 */
  async deleteSegment(
    name: string,
    segmentId: string,
    scriptFile: string,
  ): Promise<{ success: boolean; segments_count: number }> {
    const path = `/projects/${encodeURIComponent(name)}/segments/${encodeURIComponent(segmentId)}`;
    return getApi().request(
      withScriptFileQuery(path, scriptFile),
      { method: "DELETE" },
    );
  },

  /** 刪除劇集動畫模式劇本中的一個場景。 */
  async deleteScene(
    name: string,
    sceneId: string,
    scriptFile: string,
  ): Promise<{ success: boolean; scenes_count: number }> {
    const path = `/projects/${encodeURIComponent(name)}/scenes/${encodeURIComponent(sceneId)}`;
    return getApi().request(
      withScriptFileQuery(path, scriptFile),
      { method: "DELETE" },
    );
  },

  // ==================== 角色管理 ====================

  async addCharacter(
    projectName: string,
    name: string,
    description: string,
    voiceStyle: string = "",
  ): Promise<SuccessResponse> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/characters`,
      {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          voice_style: voiceStyle,
        }),
      },
    );
  },

  async updateCharacter(
    projectName: string,
    charName: string,
    updates: Record<string, unknown>,
  ): Promise<SuccessResponse> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/characters/${encodeURIComponent(charName)}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      },
    );
  },

  async deleteCharacter(
    projectName: string,
    charName: string,
  ): Promise<SuccessResponse> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/characters/${encodeURIComponent(charName)}`,
      { method: "DELETE" },
    );
  },

  async renameCharacter(
    projectName: string,
    oldName: string,
    newName: string,
  ): Promise<{
    success: boolean;
    old_name: string;
    new_name: string;
    files_moved: number;
    scripts_updated: number;
    versions_updated: number;
  }> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/characters/${encodeURIComponent(oldName)}/rename`,
      { method: "POST", body: JSON.stringify({ new_name: newName }) },
    );
  },

  // ==================== 線索管理 ====================

  async addClue(
    projectName: string,
    name: string,
    clueType: string,
    description: string,
    importance: string = "major",
  ): Promise<SuccessResponse> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/clues`,
      {
        method: "POST",
        body: JSON.stringify({
          name,
          clue_type: clueType,
          description,
          importance,
        }),
      },
    );
  },

  async updateClue(
    projectName: string,
    clueName: string,
    updates: Record<string, unknown>,
  ): Promise<SuccessResponse> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/clues/${encodeURIComponent(clueName)}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      },
    );
  },

  async deleteClue(
    projectName: string,
    clueName: string,
  ): Promise<SuccessResponse> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/clues/${encodeURIComponent(clueName)}`,
      { method: "DELETE" },
    );
  },

  async renameClue(
    projectName: string,
    oldName: string,
    newName: string,
  ): Promise<{
    success: boolean;
    old_name: string;
    new_name: string;
    files_moved: number;
    scripts_updated: number;
    versions_updated: number;
  }> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/clues/${encodeURIComponent(oldName)}/rename`,
      { method: "POST", body: JSON.stringify({ new_name: newName }) },
    );
  },

  // ==================== 場景管理 ====================

  async getScript(
    projectName: string,
    scriptFile: string,
  ): Promise<EpisodeScript> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/scripts/${encodeURIComponent(scriptFile)}`,
    );
  },

  async updateScene(
    projectName: string,
    sceneId: string,
    scriptFile: string,
    updates: Record<string, unknown>,
  ): Promise<SuccessResponse> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/scenes/${encodeURIComponent(sceneId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ script_file: scriptFile, updates }),
      },
    );
  },

  // ==================== 片段管理（說書模式） ====================

  async updateSegment(
    projectName: string,
    segmentId: string,
    updates: Record<string, unknown>,
  ): Promise<SuccessResponse> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/segments/${encodeURIComponent(segmentId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      },
    );
  },

  // ==================== 生成 API ====================

  /** 生成分鏡圖 */
  async generateStoryboard(
    projectName: string,
    segmentId: string,
    prompt: string | Record<string, unknown>,
    scriptFile: string,
  ): Promise<{ success: boolean; task_id: string; message: string }> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/generate/storyboard/${encodeURIComponent(segmentId)}`,
      {
        method: "POST",
        body: JSON.stringify({ prompt, script_file: scriptFile }),
      },
    );
  },

  /** 生成影片 */
  async generateVideo(
    projectName: string,
    segmentId: string,
    prompt: string | Record<string, unknown>,
    scriptFile: string,
    durationSeconds: number = 4,
  ): Promise<{ success: boolean; task_id: string; message: string }> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/generate/video/${encodeURIComponent(segmentId)}`,
      {
        method: "POST",
        body: JSON.stringify({
          prompt,
          script_file: scriptFile,
          duration_seconds: durationSeconds,
        }),
      },
    );
  },

  /** 生成角色設計圖 */
  async generateCharacter(
    projectName: string,
    charName: string,
    prompt: string,
  ): Promise<{ success: boolean; task_id: string; message: string }> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/generate/character/${encodeURIComponent(charName)}`,
      {
        method: "POST",
        body: JSON.stringify({ prompt }),
      },
    );
  },

  /** 生成線索設計圖 */
  async generateClue(
    projectName: string,
    clueName: string,
    prompt: string,
  ): Promise<{ success: boolean; task_id: string; message: string }> {
    return getApi().request(
      `/projects/${encodeURIComponent(projectName)}/generate/clue/${encodeURIComponent(clueName)}`,
      {
        method: "POST",
        body: JSON.stringify({ prompt }),
      },
    );
  },
};
