import type { ComponentProps, ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SegmentCard } from "./SegmentCard";
import { useAppStore } from "@/stores/app-store";
import { useVideoDurationOptions } from "@/hooks/useVideoDurationOptions";
import type { DramaScene, NarrationSegment } from "@/types";

vi.mock("@/hooks/useVideoDurationOptions", () => ({
  useVideoDurationOptions: vi.fn(),
}));

vi.mock("@/components/canvas/timeline/VersionTimeMachine", () => ({
  VersionTimeMachine: () => <div data-testid="version-time-machine">versions</div>,
}));

vi.mock("@/components/ui/AvatarStack", () => ({
  AvatarStack: ({ names }: { names: string[] }) => (
    <div data-testid="avatar-stack">{names.join(",")}</div>
  ),
}));

vi.mock("@/components/ui/ImageFlipReveal", () => ({
  ImageFlipReveal: ({
    src,
    alt,
    className,
    fallback,
  }: {
    src: string | null;
    alt: string;
    className?: string;
    fallback?: ReactNode;
  }) =>
    src ? <img src={src} alt={alt} className={className} /> : <>{fallback}</>,
}));

function makeSegment(overrides: Partial<NarrationSegment> = {}): NarrationSegment {
  return {
    segment_id: "SEG-1",
    episode: 1,
    duration_seconds: 4,
    segment_break: false,
    novel_text: "在雨夜裡抬頭。",
    characters_in_segment: ["Hero"],
    clues_in_segment: [],
    scene_in_segment: null,
    image_prompt: "一張電影感分鏡圖",
    video_prompt: "鏡頭緩慢推進",
    transition_to_next: "cut",
    generated_assets: {
      storyboard_image: "storyboards/SEG-1.png",
      video_clip: "videos/SEG-1.mp4",
      video_thumbnail: null,
      video_uri: null,
      status: "completed",
    },
    ...overrides,
  };
}

function makeDramaScene(overrides: Partial<DramaScene> = {}): DramaScene {
  return {
    scene_id: "SC-1",
    duration_seconds: 8,
    segment_break: false,
    scene_type: "劇情",
    characters_in_scene: ["Hero"],
    clues_in_scene: ["Key"],
    scene_in_scene: "古城",
    image_prompt: "一張電影感分鏡圖",
    video_prompt: {
      action: "角色抵達場景",
      camera_motion: "Static",
      ambiance_audio: "風聲",
      dialogue: [
        { speaker: "Hero", line: "抵達 @古城，看見 @Key。" },
      ],
    },
    transition_to_next: "cut",
    generated_assets: {
      storyboard_image: null,
      video_clip: null,
      video_thumbnail: null,
      video_uri: null,
      status: "pending",
    },
    ...overrides,
  };
}

type SegmentCardProps = ComponentProps<typeof SegmentCard>;

function renderSegmentCard(overrides: Partial<SegmentCardProps> = {}) {
  const props: SegmentCardProps = {
    segment: makeSegment(),
    contentMode: "narration",
    aspectRatio: "16:9",
    characters: {},
    clues: {},
    projectName: "demo",
    ...overrides,
  };

  return render(<SegmentCard {...props} />);
}

describe("SegmentCard", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.restoreAllMocks();
    vi.mocked(useVideoDurationOptions).mockReturnValue(undefined);
  });

  it("shows an image fullscreen trigger and uses native video controls", () => {
    const { container } = renderSegmentCard();

    expect(
      screen.getByRole("button", { name: "SEG-1 分鏡圖 全屏預覽" }),
    ).toBeInTheDocument();

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("preload", "metadata");
  }, 10_000);

  it("uses @mentions in narration text to update segment entities without saving markers", () => {
    const onUpdatePrompt = vi.fn();
    renderSegmentCard({
      segment: makeSegment({ clues_in_segment: [] }),
      characters: { Hero: { description: "hero" } },
      clues: {
        Key: { description: "key", importance: "major" },
      },
      onUpdatePrompt,
    });

    const source = screen.getByLabelText("原文");
    fireEvent.change(source, { target: { value: "@Hero 拿起 @Key。" } });
    fireEvent.blur(source);

    expect(onUpdatePrompt).toHaveBeenCalledWith(
      "SEG-1",
      "novel_text",
      "Hero 拿起 Key。",
      {
        characters_in_segment: ["Hero"],
        clues_in_segment: ["Key"],
      },
    );
  });

  it("highlights linked entity names in saved narration text", () => {
    renderSegmentCard({
      segment: makeSegment({
        novel_text: "Hero 拿起 Key。",
        characters_in_segment: ["Hero"],
        clues_in_segment: ["Key"],
      }),
      characters: { Hero: { description: "hero" } },
      clues: {
        Key: { description: "key", importance: "major" },
      },
    });

    const overlay = screen
      .getAllByTestId("mention-highlight-overlay")
      .find((node) => node.textContent === "Hero 拿起 Key。");

    expect(overlay).toBeDefined();
    expect(within(overlay!).getByText("Hero")).toHaveClass("text-cyan-300");
    expect(within(overlay!).getByText("Key")).toHaveClass("text-yellow-300");
  });

  it("shows live character mentions in the header before the segment is committed", () => {
    renderSegmentCard({
      segment: makeSegment({ characters_in_segment: [] }),
      characters: { "角色B": { description: "角色 B" } },
      onUpdatePrompt: vi.fn(),
    });

    const source = screen.getByLabelText("原文");
    fireEvent.change(source, { target: { value: "@角色B 進入畫面" } });

    expect(within(screen.getByTestId("avatar-stack")).getByText("角色B")).toBeInTheDocument();
  });

  it("removes live character mentions from the header when the draft becomes incomplete", () => {
    renderSegmentCard({
      segment: makeSegment({ characters_in_segment: [] }),
      characters: { "角色B": { description: "角色 B" } },
      onUpdatePrompt: vi.fn(),
    });

    const source = screen.getByLabelText("原文");
    fireEvent.change(source, { target: { value: "@角色B 進入畫面" } });
    fireEvent.change(source, { target: { value: "@角色" } });

    expect(within(screen.getByTestId("avatar-stack")).queryByText("角色B")).not.toBeInTheDocument();
  });

  it("uses @mentions in prompt text to update segment entities while keeping markers", () => {
    const onUpdatePrompt = vi.fn();
    renderSegmentCard({
      segment: makeSegment({ clues_in_segment: [] }),
      characters: { Hero: { description: "hero" } },
      clues: {
        Key: { description: "key", importance: "major" },
      },
      onUpdatePrompt,
    });

    const imagePrompt = screen.getByPlaceholderText("分鏡圖描述...");
    fireEvent.change(imagePrompt, { target: { value: "看到 @Hero 拿著 @Key" } });

    expect(onUpdatePrompt).toHaveBeenCalledWith(
      "SEG-1",
      "image_prompt",
      "看到 @Hero 拿著 @Key",
      {
        characters_in_segment: ["Hero"],
        clues_in_segment: ["Key"],
      },
    );
  });

  it("uses @scene mentions in prompt text to update the segment scene reference", () => {
    const onUpdatePrompt = vi.fn();
    renderSegmentCard({
      segment: makeSegment({
        characters_in_segment: [],
        clues_in_segment: [],
        scene_in_segment: null,
      }),
      scenes: { 古城: { description: "城牆與街道" } },
      onUpdatePrompt,
    });

    const imagePrompt = screen.getByPlaceholderText("分鏡圖描述...");
    fireEvent.change(imagePrompt, { target: { value: "遠景 @古城" } });

    expect(onUpdatePrompt).toHaveBeenCalledWith(
      "SEG-1",
      "image_prompt",
      "遠景 @古城",
      {
        scene_in_segment: "古城",
      },
    );
  });

  it("highlights known mentions inside drama dialogue lines", () => {
    renderSegmentCard({
      segment: makeDramaScene(),
      contentMode: "drama",
      characters: { Hero: { description: "hero" } },
      clues: {
        Key: { description: "key", importance: "major" },
      },
      scenes: { 古城: { description: "城牆與街道" } },
    });

    expect(screen.getByText("@古城")).toHaveClass("text-emerald-300");
    expect(screen.getByText("@Key")).toHaveClass("text-yellow-300");
  });

  it("disables unavailable duration choices when Veo constraints leave only 8 seconds", () => {
    const onUpdatePrompt = vi.fn();
    renderSegmentCard({
      segment: makeSegment({ duration_seconds: 8 }),
      durationOptions: [8],
      durationConstraintReason: "1080p/4k/參考圖強制 8 秒",
      onUpdatePrompt,
    });

    fireEvent.click(screen.getByRole("button", { name: /8s/i }));

    expect(screen.getByRole("radio", { name: "4s" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "6s" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "8s" })).not.toBeDisabled();
    expect(screen.getByRole("radio", { name: "4s" })).toHaveAttribute(
      "title",
      "1080p/4k/參考圖強制 8 秒",
    );
  });

  it("updates the per-scene video resolution when a resolution option is picked", () => {
    const onUpdatePrompt = vi.fn();
    renderSegmentCard({
      segment: makeSegment({ video_resolution: "720p" }),
      onUpdatePrompt,
    });

    // Open the resolution selector (current value shown on the trigger).
    fireEvent.click(screen.getByRole("button", { name: "影片解析度選擇" }));
    fireEvent.click(screen.getByRole("radio", { name: "1080p" }));

    expect(onUpdatePrompt).toHaveBeenCalledWith("SEG-1", "video_resolution", "1080p");
  });

  it("renders image size as a read-only chip when only one size is available", () => {
    // With provider lookups unmocked, image sizes fall back to the single
    // DEFAULT_IMAGE_SIZES entry, so the selector must not be interactive.
    renderSegmentCard({
      segment: makeSegment({ image_size: "1K" }),
      onUpdatePrompt: vi.fn(),
    });

    expect(
      screen.queryByRole("button", { name: "圖片解析度選擇" }),
    ).not.toBeInTheDocument();
  });

  it("auto-adjusts an invalid segment duration to the nearest allowed option", () => {
    const onUpdatePrompt = vi.fn();
    renderSegmentCard({
      segment: makeSegment({ duration_seconds: 4 }),
      durationOptions: [8],
      durationConstraintReason: "1080p 限制",
      onUpdatePrompt,
    });

    expect(onUpdatePrompt).toHaveBeenCalledWith("SEG-1", "duration_seconds", 8);
    expect(useAppStore.getState().toast?.text).toBe(
      "已自動將秒數從 4 調整為 8（1080p 限制）",
    );
  });

  it("prioritizes dynamicDurationOptions over project-level durationOptions", () => {
    vi.mocked(useVideoDurationOptions).mockReturnValue([12, 15]);

    const onUpdatePrompt = vi.fn();
    renderSegmentCard({
      segment: makeSegment({ duration_seconds: 12 }),
      durationOptions: [4, 6, 8],
      onUpdatePrompt,
    });

    fireEvent.click(screen.getByRole("button", { name: /12s/i }));

    expect(screen.getByRole("radio", { name: "12s" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "15s" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "4s" })).not.toBeInTheDocument();
  });
});
