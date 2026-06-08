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
    <div className={`mt-3 w-full ${hasOptions ? "grid grid-cols-3 gap-2" : "flex justify-end"}`}>
      {hasOptions && (
        <div className="col-span-2 min-w-0">
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
        className={`${hasOptions ? "col-span-1 w-full" : "w-28"} justify-center h-8 text-xs`}
      />
    </div>
  );
}
