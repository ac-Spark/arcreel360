import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import type { ProjectOverview } from "@/types";
import { OverviewSection } from "./OverviewSection";

function makeOverview(overrides: Partial<ProjectOverview> = {}): ProjectOverview {
  return {
    synopsis: "一段梗概",
    genre: "古裝懸疑",
    theme: "復仇",
    world_setting: "架空王朝",
    ...overrides,
  };
}

function renderOverviewSection(
  options: {
    overview?: ProjectOverview | null;
    onRefresh?: () => Promise<void> | void;
  } = {},
) {
  const { overview = makeOverview(), onRefresh = vi.fn() } = options;
  render(
    <OverviewSection
      projectName="demo"
      overview={overview}
      onRefresh={onRefresh}
    />,
  );
}

describe("OverviewSection", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.restoreAllMocks();
  });

  it("renders all four editable fields with current values", () => {
    renderOverviewSection();

    expect(screen.getByLabelText("故事梗概")).toHaveValue("一段梗概");
    expect(screen.getByLabelText("題材類型")).toHaveValue("古裝懸疑");
    expect(screen.getByLabelText("核心主題")).toHaveValue("復仇");
    expect(screen.getByLabelText("世界觀設定")).toHaveValue("架空王朝");
  });

  it("shows the save button only after a field is edited", () => {
    renderOverviewSection();

    expect(
      screen.queryByRole("button", { name: "儲存概述" }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("核心主題"), {
      target: { value: "成長" },
    });

    expect(
      screen.getByRole("button", { name: "儲存概述" }),
    ).toBeInTheDocument();
  });

  it("saves only the changed fields via API.updateOverview", async () => {
    const updateOverview = vi
      .spyOn(API, "updateOverview")
      .mockResolvedValue({ success: true });
    const onRefresh = vi.fn().mockResolvedValue(undefined);

    renderOverviewSection({ onRefresh });

    fireEvent.change(screen.getByLabelText("題材類型"), {
      target: { value: "都市奇幻" },
    });
    fireEvent.click(screen.getByRole("button", { name: "儲存概述" }));

    await waitFor(() => {
      expect(updateOverview).toHaveBeenCalledWith("demo", {
        genre: "都市奇幻",
      });
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it("renders the world_setting field even when overview is null", () => {
    renderOverviewSection({ overview: null });

    const worldSetting = screen.getByLabelText("世界觀設定");
    expect(worldSetting).toBeInTheDocument();
    expect(worldSetting).toHaveValue("");
  });

  it("regenerates the overview via API.generateOverview", async () => {
    const generateOverview = vi
      .spyOn(API, "generateOverview")
      .mockResolvedValue({ success: true, overview: makeOverview() });
    const onRefresh = vi.fn().mockResolvedValue(undefined);

    renderOverviewSection({ overview: null, onRefresh });

    fireEvent.click(screen.getByRole("button", { name: "生成概述" }));

    await waitFor(() => {
      expect(generateOverview).toHaveBeenCalledWith("demo");
      expect(onRefresh).toHaveBeenCalled();
    });
  });
});
