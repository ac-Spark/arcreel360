import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SegmentCard } from "./SegmentCard";
import { useAppStore } from "@/stores/app-store";
import type { NarrationSegment } from "@/types";

vi.mock("@/components/canvas/timeline/VersionTimeMachine", () => ({
  VersionTimeMachine: () => <div data-testid="version-time-machine">versions</div>,
}));

vi.mock("@/components/ui/AvatarStack", () => ({
  AvatarStack: () => <div data-testid="avatar-stack">avatars</div>,
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

describe("SegmentCard", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.restoreAllMocks();
  });

  it("shows an image fullscreen trigger and uses native video controls", () => {
    const { container } = render(
      <SegmentCard
        segment={makeSegment()}
        contentMode="narration"
        aspectRatio="16:9"
        characters={{}}
        clues={{}}
        projectName="demo"
      />,
    );

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
    render(
      <SegmentCard
        segment={makeSegment({ clues_in_segment: [] })}
        contentMode="narration"
        aspectRatio="16:9"
        characters={{ Hero: { description: "hero" } }}
        clues={{
          Key: { type: "prop", description: "key", importance: "major" },
        }}
        projectName="demo"
        onUpdatePrompt={onUpdatePrompt}
      />,
    );

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

  it("uses @mentions in prompt text to update segment entities while keeping markers", () => {
    const onUpdatePrompt = vi.fn();
    render(
      <SegmentCard
        segment={makeSegment({ clues_in_segment: [] })}
        contentMode="narration"
        aspectRatio="16:9"
        characters={{ Hero: { description: "hero" } }}
        clues={{
          Key: { type: "prop", description: "key", importance: "major" },
        }}
        projectName="demo"
        onUpdatePrompt={onUpdatePrompt}
      />,
    );

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
});
