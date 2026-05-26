import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ui/ConfirmProvider";
import { useAppStore } from "@/stores/app-store";
import { ClueCard } from "./ClueCard";

function renderClueCard(ui: ReactElement) {
  return render(ui, { wrapper: ConfirmProvider });
}

describe("ClueCard", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.restoreAllMocks();
    Object.defineProperty(globalThis.URL, "createObjectURL", {
      writable: true,
      value: vi.fn(() => "blob:clue-ref"),
    });
    Object.defineProperty(globalThis.URL, "revokeObjectURL", {
      writable: true,
      value: vi.fn(),
    });
  });

  it("renders the description field with the same visible label as other lorebook cards", () => {
    renderClueCard(
      <ClueCard
        name="玉佩"
        clue={{ description: "刻著龍紋的玉佩", importance: "major" }}
        projectName="demo"
        onSave={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );

    expect(screen.getByText("描述")).toBeInTheDocument();
    const textarea = screen.getByLabelText("描述");
    expect(textarea).toHaveValue("刻著龍紋的玉佩");

    fireEvent.change(textarea, { target: { value: "裂成兩半的玉佩" } });

    expect(textarea).toHaveValue("裂成兩半的玉佩");
  });
});
