import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimelineCanvas } from "./TimelineCanvas";
import type { ProjectData } from "@/types";

vi.mock("./SegmentCard", () => ({
  SegmentCard: () => <div data-testid="segment-card" />,
}));

vi.mock("./EpisodeActionsBar", () => ({
  EpisodeActionsBar: () => <div data-testid="episode-actions" />,
}));

vi.mock("./FinalVideoCard", () => ({
  FinalVideoCard: () => <div data-testid="final-video" />,
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
});
