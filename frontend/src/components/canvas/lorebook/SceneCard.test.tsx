import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ui/ConfirmProvider";
import { SceneCard } from "./SceneCard";
import { useAppStore } from "@/stores/app-store";

function renderSceneCard(ui: ReactElement) {
  return render(ui, { wrapper: ConfirmProvider });
}

describe("SceneCard", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.restoreAllMocks();
    Object.defineProperty(globalThis.URL, "createObjectURL", {
      writable: true,
      value: vi.fn(() => "blob:scene-ref"),
    });
    Object.defineProperty(globalThis.URL, "revokeObjectURL", {
      writable: true,
      value: vi.fn(),
    });
  });

  it("renders the scene description", () => {
    renderSceneCard(
      <SceneCard
        name="廢棄醫院"
        scene={{ description: "陰森的走廊" }}
        projectName="demo"
        onSave={vi.fn()}
        onToggleUseUploaded={vi.fn()}
      />,
    );

    expect(screen.getByText("廢棄醫院")).toBeInTheDocument();
    const textarea = screen.getByPlaceholderText("輸入場景描述...");
    expect(textarea).toHaveValue("陰森的走廊");
  });

  it("renders existing saved scene_sheet image", () => {
    renderSceneCard(
      <SceneCard
        name="廢棄醫院"
        scene={{
          description: "陰森的走廊",
          scene_sheet: "scenes/廢棄醫院.png",
        }}
        projectName="demo"
        onSave={vi.fn()}
        onToggleUseUploaded={vi.fn()}
      />,
    );

    expect(screen.getByAltText("廢棄醫院 設計圖")).toHaveAttribute(
      "src",
      "/api/v1/files/demo/scenes/廢棄醫院.png",
    );
  });

  it("calls onToggleUseUploaded when the switch is clicked", async () => {
    const onToggle = vi.fn().mockResolvedValue(undefined);
    renderSceneCard(
      <SceneCard
        name="廢棄醫院"
        scene={{ description: "陰森的走廊", use_uploaded_as_final: false }}
        projectName="demo"
        onSave={vi.fn()}
        onToggleUseUploaded={onToggle}
      />,
    );

    const sw = screen.getByRole("switch", {
      name: "直接以上傳圖為最終成品",
    });
    expect(sw).toHaveAttribute("aria-checked", "false");

    fireEvent.click(sw);

    await waitFor(() => {
      expect(onToggle).toHaveBeenCalledWith("廢棄醫院", true);
    });
  });

  it("submits description changes through onSave", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderSceneCard(
      <SceneCard
        name="廢棄醫院"
        scene={{ description: "陰森的走廊" }}
        projectName="demo"
        onSave={onSave}
        onToggleUseUploaded={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText("輸入場景描述...");
    fireEvent.change(textarea, { target: { value: "陰森的走廊與破窗" } });

    fireEvent.click(screen.getByRole("button", { name: "儲存" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("廢棄醫院", {
        description: "陰森的走廊與破窗",
        referenceFile: null,
      });
    });
  });

  it("keeps a selected reference file and submits it on save", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { container } = renderSceneCard(
      <SceneCard
        name="廢棄醫院"
        scene={{ description: "陰森的走廊" }}
        projectName="demo"
        onSave={onSave}
        onToggleUseUploaded={vi.fn()}
      />,
    );

    const fileInput = container.querySelector("input[type='file']");
    expect(fileInput).not.toBeNull();

    const file = new File(["ref"], "scene.png", { type: "image/png" });
    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [file] },
    });

    expect(screen.getByText("待儲存參考圖")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "儲存" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("廢棄醫院", {
        description: "陰森的走廊",
        referenceFile: file,
      });
    });
  });

  it("confirms before deleting", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    renderSceneCard(
      <SceneCard
        name="廢棄醫院"
        scene={{ description: "陰森的走廊" }}
        projectName="demo"
        onSave={vi.fn()}
        onToggleUseUploaded={vi.fn()}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "刪除場景 廢棄醫院" }),
    );

    const confirmBtn = await screen.findByRole("button", { name: "確定" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith("廢棄醫院");
    });
  });
});
