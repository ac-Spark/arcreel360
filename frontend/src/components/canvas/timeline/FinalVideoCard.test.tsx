import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { FinalVideoCard } from "./FinalVideoCard";

vi.mock("@/api", () => ({
  API: {
    getFileUrl: vi.fn((projectName: string, path: string) => `/api/v1/files/${projectName}/${path}`),
    listFiles: vi.fn(),
  },
}));

describe("FinalVideoCard", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.mocked(API.listFiles).mockReset();
    vi.mocked(API.getFileUrl).mockClear();
  });

  it("shows a single legacy final output when the deterministic episode file is missing", async () => {
    vi.mocked(API.listFiles).mockResolvedValue({
      files: {
        output: [
          {
            name: "第一章：午後的回憶_final.mp4",
            size: 1024 * 1024,
            url: "/api/v1/files/demo/output/第一章：午後的回憶_final.mp4",
          },
        ],
      },
    });

    render(<FinalVideoCard projectName="demo" episode={1} />);

    expect(await screen.findByText("第一章：午後的回憶_final.mp4")).toBeInTheDocument();
    await waitFor(() => {
      expect(API.getFileUrl).toHaveBeenCalledWith("demo", "output/第一章：午後的回憶_final.mp4");
    });
  });
});
