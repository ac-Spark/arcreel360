import { useState } from "react";
import { X, Loader2 } from "lucide-react";

interface AddSceneFormProps {
  onSubmit: (name: string, description: string) => Promise<void>;
  onCancel: () => void;
}

export function AddSceneForm({ onSubmit, onCancel }: AddSceneFormProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !description.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit(name.trim(), description.trim());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="mt-4 rounded-xl border border-indigo-500/30 bg-gray-900 p-4"
      data-workspace-editing="true"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200">新增場景</h3>
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-400">
            名稱 <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="場景名稱"
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 outline-none focus:border-indigo-500"
            autoFocus
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-400">
            描述 <span className="text-red-400">*</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="場景的環境、氛圍、視覺特徵等描述..."
            rows={3}
            className="w-full resize-none rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 outline-none focus:border-indigo-500"
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-400 transition-colors hover:text-gray-200"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim() || !description.trim()}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                新增中...
              </span>
            ) : (
              "新增"
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
