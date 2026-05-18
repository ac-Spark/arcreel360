import type { EntityMentionSources } from "@/utils/entity-mentions";

export type MentionToken =
  | { type: "text"; value: string }
  | { type: "mention"; value: string; name: string; kind: "character" | "clue" };

interface MentionCandidate {
  name: string;
  kind: "character" | "clue";
}

function sortedCandidates(entities: EntityMentionSources): MentionCandidate[] {
  return [
    ...Object.keys(entities.characters)
      .filter(Boolean)
      .map((name) => ({ name, kind: "character" as const })),
    ...Object.keys(entities.clues)
      .filter(Boolean)
      .map((name) => ({ name, kind: "clue" as const })),
  ].sort((a, b) => b.name.length - a.name.length);
}

function isMentionStart(text: string, index: number): boolean {
  if (text[index] !== "@") return false;
  if (index === 0) return true;
  return /\s/.test(text[index - 1]);
}

function isMentionBoundary(char: string | undefined): boolean {
  if (char === undefined) return true;
  if (/\s/.test(char)) return true;
  return !/[\p{L}\p{N}_]/u.test(char);
}

function findMentionAt(
  text: string,
  start: number,
  candidates: MentionCandidate[],
): MentionCandidate | null {
  return candidates.find((candidate) => {
    if (!text.startsWith(candidate.name, start)) {
      return false;
    }

    return isMentionBoundary(text[start + candidate.name.length]);
  }) ?? null;
}

function appendText(tokens: MentionToken[], value: string): void {
  if (!value) return;

  const previous = tokens[tokens.length - 1];
  if (previous?.type === "text") {
    previous.value += value;
    return;
  }

  tokens.push({ type: "text", value });
}

export function tokenizeForHighlight(
  text: string,
  entities: EntityMentionSources,
): MentionToken[] {
  const candidates = sortedCandidates(entities);
  const tokens: MentionToken[] = [];
  let textStart = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (!isMentionStart(text, index)) {
      continue;
    }

    const mention = findMentionAt(text, index + 1, candidates);
    if (!mention) {
      continue;
    }

    appendText(tokens, text.slice(textStart, index));
    tokens.push({
      type: "mention",
      value: `@${mention.name}`,
      name: mention.name,
      kind: mention.kind,
    });
    index += mention.name.length;
    textStart = index + 1;
  }

  appendText(tokens, text.slice(textStart));
  return tokens;
}
