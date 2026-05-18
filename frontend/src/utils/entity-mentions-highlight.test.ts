import { describe, expect, it } from "vitest";
import { tokenizeForHighlight } from "@/utils/entity-mentions-highlight";

const entities = {
  characters: {
    "角色B": {},
    "錦衣衛": {},
    A: {},
  },
  clues: {
    "道具A": {},
  },
};

describe("tokenizeForHighlight", () => {
  it("returns a single text token for pure text without @", () => {
    expect(tokenizeForHighlight("沒有任何標記", entities)).toEqual([
      { type: "text", value: "沒有任何標記" },
    ]);
  });

  it("tokenizes a known character mention", () => {
    expect(tokenizeForHighlight("看見 @錦衣衛", entities)).toEqual([
      { type: "text", value: "看見 " },
      { type: "mention", value: "@錦衣衛", name: "錦衣衛", kind: "character" },
    ]);
  });

  it("keeps a partial known name as text", () => {
    expect(tokenizeForHighlight("@錦衣", entities)).toEqual([
      { type: "text", value: "@錦衣" },
    ]);
  });

  it("tokenizes mixed clue and character mentions with intervening text", () => {
    expect(tokenizeForHighlight("@道具A @角色B 文字", entities)).toEqual([
      { type: "mention", value: "@道具A", name: "道具A", kind: "clue" },
      { type: "text", value: " " },
      { type: "mention", value: "@角色B", name: "角色B", kind: "character" },
      { type: "text", value: " 文字" },
    ]);
  });

  it("keeps a known prefix followed by non-space unknown chars as text", () => {
    expect(tokenizeForHighlight("@Aplus", entities)).toEqual([
      { type: "text", value: "@Aplus" },
    ]);
  });

  it("does not tokenize @ preceded by a non-whitespace character", () => {
    expect(tokenizeForHighlight("email@example.com", entities)).toEqual([
      { type: "text", value: "email@example.com" },
    ]);
  });

  it("keeps a known name embedded after an unknown @ prefix as text", () => {
    expect(tokenizeForHighlight("@未知錦衣衛", entities)).toEqual([
      { type: "text", value: "@未知錦衣衛" },
    ]);
  });
});
