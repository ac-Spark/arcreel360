import { useCallback, useEffect, useId, useRef } from "react";

interface LorebookDescriptionFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
  label?: string;
  rows?: number;
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
      <label htmlFor={id} className="block text-xs font-medium text-gray-400">
        {label}
      </label>
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
    </div>
  );
}
