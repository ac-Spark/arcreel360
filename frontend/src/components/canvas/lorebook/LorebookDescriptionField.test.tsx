import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LorebookDescriptionField } from "./LorebookDescriptionField";

describe("LorebookDescriptionField", () => {
  it("stacks the text model selector above the generate button", () => {
    render(
      <LorebookDescriptionField
        value=""
        onChange={vi.fn()}
        placeholder="輸入描述"
        onGenerateAI={vi.fn()}
        textModel={null}
        onTextModelChange={vi.fn()}
        textModelOptions={["openai/gpt-4.1-mini", "gemini-aistudio/gemini-2.5-pro-preview-06-05"]}
        providerNames={{ openai: "OpenAI", "gemini-aistudio": "Gemini AI Studio" }}
      />,
    );

    const generateButton = screen.getByRole("button", { name: "生成描述" });
    const controls = generateButton.parentElement;
    if (!controls) throw new Error("missing description controls");

    expect(controls).toHaveClass("flex-col");
    expect(controls).not.toHaveClass("grid");
    expect(controls.firstElementChild).toHaveClass("w-full");
    expect(controls.firstElementChild).not.toHaveClass("col-span-2");
  });
});
