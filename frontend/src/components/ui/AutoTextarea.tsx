import { useCallback, useEffect, useRef } from "react";
import type { ChangeEvent } from "react";
import { EntityMentionMenu } from "@/components/canvas/timeline/EntityMentionMenu";
import { useEntityMentionInput } from "@/components/canvas/timeline/useEntityMentionInput";
import type { EntityMentionSources } from "@/utils/entity-mentions";

interface AutoTextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** 提供時啟用 @ 角色/道具自動補完選單。 */
  entities?: EntityMentionSources;
}

const EMPTY_MENTION_ENTITIES: EntityMentionSources = {
  characters: {},
  clues: {},
};

/** Auto-resizing textarea that grows with its content.
 *  Optionally supports `@` entity mention menu when `entities` is provided. */
export function AutoTextarea({
  value,
  onChange,
  placeholder,
  className,
  entities,
}: AutoTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  const mentionEnabled = Boolean(entities);
  const mention = useEntityMentionInput({
    value,
    onChange,
    entities: entities ?? EMPTY_MENTION_ENTITIES,
    textareaRef: ref,
  });

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    if (mentionEnabled) {
      mention.handleInputChange(e);
      return;
    }

    onChange(e.target.value);
  };

  const textarea = (
    <textarea
      ref={ref}
      value={value}
      onChange={handleChange}
      onInput={resize}
      onKeyDown={mentionEnabled ? mention.handleKeyDown : undefined}
      placeholder={placeholder}
      rows={2}
      role={mentionEnabled ? "combobox" : undefined}
      aria-autocomplete={mentionEnabled ? "list" : undefined}
      aria-expanded={mentionEnabled ? mention.menuOpen : undefined}
      aria-controls={mentionEnabled && mention.menuOpen ? "entity-mention-menu" : undefined}
      className={`w-full resize-none overflow-hidden bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-2 font-mono text-xs text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none ${className ?? ""}`}
    />
  );

  if (!mentionEnabled) return textarea;

  return (
    <div className="relative">
      {textarea}
      {mention.menuOpen && (
        <EntityMentionMenu
          ref={mention.menuRef}
          filter={mention.filter}
          items={mention.items}
          onSelect={mention.selectItem}
          className="absolute left-0 top-full mt-1 w-full"
        />
      )}
    </div>
  );
}
