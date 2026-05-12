import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimelineCanvas } from "./TimelineCanvas";
import { API } from "@/api";
import type { ProjectData } from "@/types";

vi.mock("@/api", () => ({
  API: {
    addEpisodeSegment: vi.fn(),
    addEpisodeScene: vi.fn(),
    getProject: vi.fn().mockResolvedValue({ project: {}, scripts: {}, asset_fingerprints: {} }),
    listFiles: vi.fn().mockResolvedValue({ files: { source: [] } }),
  },
}));

vi.mock("./SegmentCard", () => ({
  SegmentCard: () => <div data-testid="segment-card" />,
}));

vi.mock("./EpisodeActionsBar", () => ({
  EpisodeActionsBar: () => <div data-testid="episode-actions" />,
}));

vi.mock("./FinalVideoCard", () => ({
  FinalVideoCard: () => <div data-testid="final-video" />,
}));

vi.mock("./EpisodeSplitPanel", () => ({
  EpisodeSplitPanel: () => <div data-testid="episode-split-panel" />,
}));

vi.mock("./PreprocessingView", () => ({
  PreprocessingView: () => <div data-testid="preprocessing-view" />,
}));

function makeProjectData(): ProjectData {
  return {
    title: "Demo",
    content_mode: "narration",
    style: "Anime",
    episodes: [{ episode: 1, title: "第一集", script_file: "scripts/episode_1.json" }],
    characters: {},
    clues: {},
  };
}

describe("TimelineCanvas", () => {
  it("uses scenes when a script is drama-shaped even if the project is narration mode", () => {
    render(
      <TimelineCanvas
        projectName="demo"
        episode={1}
        episodeTitle="第一集"
        projectData={makeProjectData()}
        episodeScript={{
          episode: 1,
          title: "第一集",
          duration_seconds: 8,
          summary: "",
          novel: { title: "", chapter: "" },
          scenes: [
            {
              scene_id: "scene_1",
              duration_seconds: 8,
              segment_break: false,
              scene_type: "dialogue",
              characters_in_scene: [],
              clues_in_scene: [],
              image_prompt: "image prompt",
              video_prompt: "video prompt",
              transition_to_next: "cut",
            },
          ],
        } as never}
      />,
    );

    expect(screen.getByText("1 個場景 · 約 8s")).toBeInTheDocument();
  });

  it("renders the editor with an add-segment button when the script has no segments", async () => {
    vi.mocked(API.addEpisodeSegment).mockResolvedValue({ segment: {}, segments_count: 1 });
    render(
      <TimelineCanvas
        projectName="demo"
        episode={1}
        episodeTitle="第一集"
        projectData={makeProjectData()}
        episodeScript={
          {
            episode: 1,
            title: "第一集",
            content_mode: "narration",
            duration_seconds: 0,
            summary: "",
            novel: { title: "", chapter: "" },
            segments: [],
          } as never
        }
      />,
    );

    // 空狀態提示 + 新增按鈕
    expect(screen.getByText("這一集還沒有片段，點上方按鈕新增。")).toBeInTheDocument();
    const addBtn = screen.getByRole("button", { name: "新增片段" });
    fireEvent.click(addBtn);
    await waitFor(() => expect(API.addEpisodeSegment).toHaveBeenCalledWith("demo", 1));
    // 成功後會 refetch（getProject）
    await waitFor(() => expect(API.getProject).toHaveBeenCalledWith("demo"));
  });
});
