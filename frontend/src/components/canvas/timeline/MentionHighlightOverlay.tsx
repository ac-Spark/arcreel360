import { forwardRef, useMemo } from "react";
import type { EntityMentionSources } from "@/utils/entity-mentions";
import { tokenizeForHighlight } from "@/utils/entity-mentions-highlight";

interface MentionHighlightOverlayProps {
  value: string;
  entities: EntityMentionSources;
  /** 應與外層 textarea 完全一致的 padding / font / line-height / letter-spacing 等 className。 */
  className?: string;
}

/**
 * 後置疊在 textarea 後面、用來把已知 @角色/道具 高亮顯示的 mirror 層。
 *
 * 使用方:
 * - 用 `<div class="relative">` 同時包住 textarea 與本元件
 * - textarea 設 `color: transparent; caret-color: currentColor`
 * - 本元件設 `absolute inset-0 pointer-events-none` 並複製 textarea 的 metric class
 */
export const MentionHighlightOverlay = forwardRef<HTMLPreElement, MentionHighlightOverlayProps>(
  function MentionHighlightOverlay({ value, entities, className = "" }, ref) {
    const tokens = useMemo(() => tokenizeForHighlight(value, entities), [value, entities]);

    return (
      <pre
        ref={ref}
        aria-hidden="true"
        data-testid="mention-highlight-overlay"
        className={`pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words ${className}`}
      >
        {tokens.map((token, index) => {
          if (token.type === "text") {
            return <span key={index}>{token.value}</span>;
          }
          const cls = token.kind === "character"
            ? "bg-cyan-400/15 text-cyan-300 rounded px-0.5 box-decoration-clone"
            : "bg-yellow-400/15 text-yellow-300 rounded px-0.5 box-decoration-clone";
          return (
            <span key={index} className={cls}>
              {token.value}
            </span>
          );
        })}
        {/* 結尾若是換行,加一個 zero-width space 讓最後一行高度被計算到,避免捲動位移 */}
        {value.endsWith("\n") && "​"}
      </pre>
    );
  },
);
