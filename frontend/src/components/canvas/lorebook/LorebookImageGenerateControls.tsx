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
  const hasOptions = options.length > 0;

  return (
    <div className="mt-3 flex flex-col gap-2 w-full">
      {hasOptions && (
        <div className="w-full min-w-0">
          <ProviderModelSelect
            value={value}
            onChange={(next) => void onChange(next)}
            options={options}
            providerNames={providerNames}
            placeholder="選擇圖片模型..."
            allowDefault={true}
            defaultLabel="專案預設"
            className="w-full text-xs"
            size="sm"
          />
        </div>
      )}
      <GenerateButton
        onClick={() => void onGenerate()}
        loading={loading}
        label={label}
        className="w-full justify-center h-8 text-xs"
      />
    </div>
  );
}
