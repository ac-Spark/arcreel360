import { GenerateButton } from "@/components/ui/GenerateButton";
import { ProviderModelSelect } from "@/components/ui/ProviderModelSelect";

interface LorebookImageGenerateControlsProps {
  value: string;
  onChange: (value: string) => Promise<void> | void;
  options?: string[];
  providerNames?: Record<string, string>;
  onGenerate: () => Promise<void> | void;
  loading?: boolean;
  label: string;
}

export function LorebookImageGenerateControls({
  value,
  onChange,
  options = [],
  providerNames = {},
  onGenerate,
  loading,
  label,
}: LorebookImageGenerateControlsProps) {
  return (
    <div className="mt-3 flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <ProviderModelSelect
          value={value}
          onChange={(next) => void onChange(next)}
          options={options}
          providerNames={providerNames}
          placeholder="選擇圖片模型..."
          allowDefault={true}
          defaultLabel="跟隨專案圖片模型"
          className="w-full text-xs"
          size="sm"
        />
      </div>
      <GenerateButton
        onClick={() => void onGenerate()}
        loading={loading}
        label={label}
        className="w-28 shrink-0 justify-center h-8 text-xs"
      />
    </div>
  );
}
