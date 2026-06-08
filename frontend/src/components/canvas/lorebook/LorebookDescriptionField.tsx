import { useId } from "react";
import { GenerateButton } from "@/components/ui/GenerateButton";
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
  "mt-1 w-full h-28 resize-none overflow-y-auto rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none";

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
  const hasTextModelOptions = (textModelOptions?.length ?? 0) > 0;
  const controlsClassName = hasTextModelOptions ? "mt-3 grid grid-cols-3 gap-2 w-full" : "mt-3 flex justify-end";
  const generateButtonClassName = hasTextModelOptions
    ? "col-span-1 w-full justify-center h-8 text-xs"
    : "w-28 justify-center h-8 text-xs";

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={id} className="block text-xs font-medium text-gray-400">
          {label}
        </label>
      </div>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className={TEXTAREA_CLASS}
        placeholder={placeholder}
      />
      {onGenerateAI && (
        <div className={controlsClassName}>
          {hasTextModelOptions && (
            <div className="col-span-2 min-w-0">
              <ProviderModelSelect
                value={textModel || ""}
                options={textModelOptions ?? []}
                providerNames={providerNames || {}}
                onChange={(val) => onTextModelChange?.(val || null)}
                placeholder="選擇文字模型..."
                allowDefault={true}
                defaultLabel="專案預設"
                className="w-full text-xs"
                size="sm"
              />
            </div>
          )}
          <GenerateButton
            onClick={() => void onGenerateAI()}
            loading={aiGenerating}
            label="生成描述"
            className={generateButtonClassName}
            disabled={aiGenerating}
          />
        </div>
      )}
    </div>
  );
}
