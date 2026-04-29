import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { API } from "@/api";
import { ProviderSection } from "./ProviderSection";

vi.mock("./ProviderDetail", () => ({
  ProviderDetail: () => <div data-testid="provider-detail" />,
}));

vi.mock("./settings/CustomProviderDetail", () => ({
  CustomProviderDetail: () => <div data-testid="custom-provider-detail" />,
}));

vi.mock("./settings/CustomProviderForm", () => ({
  CustomProviderForm: () => <div data-testid="custom-provider-form" />,
}));

describe("ProviderSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders preset providers even when custom providers fail to load", async () => {
    vi.spyOn(API, "getProviders").mockResolvedValue({
      providers: [
        {
          id: "gemini-aistudio",
          display_name: "AI Studio",
          description: "Google AI Studio",
          status: "ready",
          media_types: ["image", "video", "text"],
          capabilities: [],
          configured_keys: [],
          missing_keys: [],
          models: {},
        },
      ],
    });
    vi.spyOn(API, "listCustomProviders").mockRejectedValue(new Error("boom"));

    const location = memoryLocation({ path: "/app/settings?section=providers", record: true });
    render(
      <Router hook={location.hook}>
        <ProviderSection />
      </Router>,
    );

    await waitFor(() => {
      expect(screen.getByText("AI Studio")).toBeInTheDocument();
    });

    expect(screen.queryByText("加载供应商列表…")).not.toBeInTheDocument();
    expect(screen.getByText("自定义供应商加载失败，页面已显示可用结果。")).toBeInTheDocument();
  });
});