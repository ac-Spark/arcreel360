import { useCallback, useEffect, useId, useRef } from "react";
import { Sparkles } from "lucide-react";
import { ProviderModelSelect } from "@/components/ui/ProviderModelSelect";

interface LorebookDescriptionFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
  label?: string;
  rows?: number;
  onGenerateAI?: () => Promise<void> | void;
  aiGenerating?: boolean;
  textModel?: string | null;
  onTextModelChange?: (model: string | null) => void;
  textModelOptions?: string[];
  providerNames?: Record<string, string>;
}

const TEXTAREA_CLASS =
  "mt-1 w-full resize-none overflow-hidden rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none";

export function LorebookDescriptionField({
  value,
  onChange,
  placeholder,
  className,
  label = "描述",
  rows = 3,
  onGenerateAI,
  aiGenerating,
  textModel,
  onTextModelChange,
  textModelOptions,
  providerNames,
}: LorebookDescriptionFieldProps) {
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    autoResize();
  }, [autoResize, value]);

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={id} className="block text-xs font-medium text-gray-400">
          {label}
        </label>
      </div>
      <textarea
        id={id}
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onInput={autoResize}
        rows={rows}
        className={TEXTAREA_CLASS}
        placeholder={placeholder}
      />
      {onGenerateAI && (
        <div className="flex items-center gap-2 mt-1.5 w-full">
          {textModelOptions && textModelOptions.length > 0 && (
            <ProviderModelSelect
              value={textModel || ""}
              options={textModelOptions}
              providerNames={providerNames || {}}
              onChange={(val) => onTextModelChange?.(val || null)}
              placeholder="選模型..."
              allowDefault={true}
              defaultLabel="預設文字模型"
              className="flex-1 text-xs"
              size="sm"
            />
          )}
          <button
            type="button"
            onClick={onGenerateAI}
            disabled={aiGenerating}
            className="flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-semibold text-indigo-400 hover:text-indigo-300 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none border border-gray-700/50 hover:border-gray-600/50 bg-gray-800/40 rounded-md hover:bg-gray-800/80 transition-all shrink-0"
            title="調用 AI 擴寫並生成英文生圖提示詞"
          >
            <Sparkles className={`h-3 w-3 ${aiGenerating ? "animate-spin" : ""}`} />
            {aiGenerating ? "生成中..." : "AI 產生"}
          </button>
        </div>
      )}
    </div>
  );
}
