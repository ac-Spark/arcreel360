/**
 * 「直接以上傳圖為最終成品」開關。
 *
 * 角色 / 道具 / 場景三張卡片共用。開啟時，上傳的參考圖會被後端
 * 直接複製為設計圖（*_sheet），不再經 AI 生成。
 *
 * 專案無現成 Toggle/Switch 元件，這裡以原生 checkbox + `role="switch"`
 * 樣式化，對齊深色主題。
 */

interface UseUploadedAsFinalToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

export function UseUploadedAsFinalToggle({
  checked,
  onChange,
  disabled = false,
}: UseUploadedAsFinalToggleProps) {
  return (
    <label
      className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
        checked
          ? "border-indigo-500/40 bg-indigo-500/10"
          : "border-gray-700 bg-gray-800/50"
      } ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label="直接以上傳圖為最終成品"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 ${
          checked ? "bg-indigo-600" : "bg-gray-600"
        } ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
      <span className="min-w-0 text-xs">
        <span className="font-medium text-gray-200">直接以上傳圖為最終成品</span>
        <span className="mt-0.5 block text-gray-500">
          {checked
            ? "上傳的參考圖將直接作為最終成品，不再經 AI 生成"
            : "關閉時：參考圖僅作為 AI 生成設計圖的參考"}
        </span>
      </span>
    </label>
  );
}
