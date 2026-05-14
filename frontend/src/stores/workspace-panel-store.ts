import type { StateCreator } from "zustand";
import type { AppState, WorkspacePanelSlice } from "./app-store-types";

export const createWorkspacePanelSlice: StateCreator<
  AppState,
  [],
  [],
  WorkspacePanelSlice
> = (set) => ({
  assistantPanelOpen: true,
  toggleAssistantPanel: () =>
    set((state) => ({ assistantPanelOpen: !state.assistantPanelOpen })),
  setAssistantPanelOpen: (open) => set({ assistantPanelOpen: open }),
  taskHudOpen: false,
  setTaskHudOpen: (open) => set({ taskHudOpen: open }),
});
