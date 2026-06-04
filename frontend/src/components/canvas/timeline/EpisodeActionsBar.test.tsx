import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import { ConfirmProvider } from "@/components/ui/ConfirmProvider";
import { useAppStore } from "@/stores/app-store";
import { useProjectsStore } from "@/stores/projects-store";
import { EpisodeActionsBar } from "./EpisodeActionsBar";

vi.mock("@/api", () => ({
  API: {
    batchGenerateStoryboards: vi.fn(),
  },
}));

function renderActions(ui: ReactElement) {
  return render(ui, { wrapper: ConfirmProvider });
}

function renderTimelineActions() {
  return renderActions(
    <EpisodeActionsBar
      projectName="demo"
      episode={1}
      scriptFile="scripts/episode_1.json"
      hasScript
    />,
  );
}

describe("EpisodeActionsBar", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    useProjectsStore.setState(useProjectsStore.getInitialState(), true);
    vi.clearAllMocks();
    vi.mocked(API.batchGenerateStoryboards).mockResolvedValue({ enqueued: ["SEG-1"], skipped: [] });
  });

  it("opens storyboard generation choices from the batch button", async () => {
    renderTimelineActions();

    expect(screen.queryByRole("button", { name: "強制重生" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "批次生成分鏡" }));

    expect(await screen.findByRole("dialog", { name: "批次生成分鏡" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "只生成缺少的分鏡" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部重生分鏡" })).toBeInTheDocument();
    expect(API.batchGenerateStoryboards).not.toHaveBeenCalled();
  });

  it("can force regenerate all storyboards from the choice dialog", async () => {
    renderTimelineActions();

    fireEvent.click(screen.getByRole("button", { name: "批次生成分鏡" }));
    fireEvent.click(await screen.findByRole("button", { name: "全部重生分鏡" }));

    await waitFor(() => {
      expect(API.batchGenerateStoryboards).toHaveBeenCalledWith("demo", {
        script_file: "scripts/episode_1.json",
        force: true,
      });
    });
  });

  it("does not render the batch video generation action", () => {
    renderTimelineActions();

    expect(screen.queryByRole("button", { name: "批次生成影片" })).not.toBeInTheDocument();
  });
});
