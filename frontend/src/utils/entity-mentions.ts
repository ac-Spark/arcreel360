export interface EntityMentionSources {
  characters: Record<string, unknown>;
  clues: Record<string, unknown>;
}

export interface EntityMentionNames {
  characterNames: string[];
  clueNames: string[];
}

export function hasEntityMentions(mentions: EntityMentionNames): boolean {
  return mentions.characterNames.length > 0 || mentions.clueNames.length > 0;
}

export function mergeEntityMentionNames(
  current: EntityMentionNames,
  mentions: EntityMentionNames,
): EntityMentionNames {
  return {
    characterNames: unique([...current.characterNames, ...mentions.characterNames]),
    clueNames: unique([...current.clueNames, ...mentions.clueNames]),
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function sortedEntityNames(source: Record<string, unknown>): string[] {
  return Object.keys(source).filter(Boolean).sort((a, b) => b.length - a.length);
}

function findKnownNameAt(text: string, start: number, names: string[]): string | null {
  return names.find((name) => text.startsWith(name, start)) ?? null;
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, output);
    }
    return output;
  }

  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      collectStrings(item, output);
    }
  }

  return output;
}

export function extractEntityMentions(
  text: string,
  entities: EntityMentionSources,
): EntityMentionNames {
  const characterNames = sortedEntityNames(entities.characters);
  const clueNames = sortedEntityNames(entities.clues);
  const foundCharacters: string[] = [];
  const foundClues: string[] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@") {
      continue;
    }

    const mentionStart = index + 1;
    const characterName = findKnownNameAt(text, mentionStart, characterNames);
    const clueName = findKnownNameAt(text, mentionStart, clueNames);

    if (characterName) {
      foundCharacters.push(characterName);
    }
    if (clueName) {
      foundClues.push(clueName);
    }

    const longestMatch = [characterName, clueName]
      .filter((name): name is string => Boolean(name))
      .sort((a, b) => b.length - a.length)[0];
    if (longestMatch) {
      index += longestMatch.length;
    }
  }

  return {
    characterNames: unique(foundCharacters),
    clueNames: unique(foundClues),
  };
}

export function stripKnownEntityMentionMarkers(
  text: string,
  entities: EntityMentionSources,
): string {
  const knownNames = unique([
    ...sortedEntityNames(entities.characters),
    ...sortedEntityNames(entities.clues),
  ]).sort((a, b) => b.length - a.length);

  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "@") {
      const name = findKnownNameAt(text, index + 1, knownNames);
      if (name) {
        output += name;
        index += name.length;
        continue;
      }
    }

    output += text[index];
  }

  return output;
}

export function extractEntityMentionsFromValue(
  value: unknown,
  entities: EntityMentionSources,
): EntityMentionNames {
  return extractEntityMentions(collectStrings(value).join("\n"), entities);
}

export function buildEntityMentionUpdates(
  value: unknown,
  entities: EntityMentionSources,
  current: EntityMentionNames,
): EntityMentionNames {
  return mergeEntityMentionNames(current, extractEntityMentionsFromValue(value, entities));
}
