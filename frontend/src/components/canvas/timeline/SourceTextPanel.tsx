import { useEffect, useState } from "react";
import { BookOpen, ChevronRight, ChevronLeft, Copy, Check } from "lucide-react";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";

interface SourceTextPanelProps {
  projectName: string;
  episode: number;
  activeSegmentIndex: number | null;
  onSelectSegmentIndex?: (index: number) => void;
}

export function SourceTextPanel({
  projectName,
  episode,
  activeSegmentIndex,
  onSelectSegmentIndex,
}: SourceTextPanelProps) {
  const [open, setOpen] = useState(false);
  const [paragraphs, setParagraphs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!projectName || !episode) return;
    let cancelled = false;
    setLoading(true);
    API.getSourceParagraphs(projectName, episode)
      .then((res) => {
        if (!cancelled) {
          setParagraphs(res.paragraphs || []);
        }
      })
      .catch((err) => {
        console.error("Failed to load source paragraphs:", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectName, episode]);

  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    useAppStore.getState().pushToast("已複製原文段落", "success");
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-4 top-1/2 z-20 -translate-y-1/2 rounded-l-xl border border-gray-700 bg-gray-900 p-2.5 text-gray-400 hover:bg-gray-800 hover:text-gray-200 shadow-xl transition-all flex flex-col items-center gap-1"
        title="展開原文對照"
      >
        <ChevronLeft className="h-4 w-4" />
        <BookOpen className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-gray-800 bg-gray-950/50">
      <div className="flex items-center justify-between border-b border-gray-800 p-3.5">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-indigo-400" />
          <h4 className="text-sm font-semibold text-gray-200">原文對照</h4>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
          title="收合"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading ? (
          <div className="py-8 text-center text-xs text-gray-600">載入原文段落中...</div>
        ) : paragraphs.length === 0 ? (
          <div className="py-8 text-center text-xs text-gray-600">
            未找到 Step 1 預處理段落，請先執行預處理。
          </div>
        ) : (
          paragraphs.map((para, idx) => {
            const isActive = activeSegmentIndex === idx;
            return (
              <div
                key={idx}
                onClick={() => onSelectSegmentIndex?.(idx)}
                className={`group relative rounded-xl border p-3 transition-all cursor-pointer ${
                  isActive
                    ? "border-indigo-500/50 bg-indigo-500/10 text-gray-100 ring-1 ring-indigo-500/30"
                    : "border-gray-800 bg-gray-900/40 text-gray-400 hover:border-gray-700 hover:text-gray-300"
                }`}
              >
                <div className="mb-1 flex items-center justify-between text-[10px] font-medium tracking-wider uppercase text-gray-500">
                  <span>段落 {idx + 1}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCopy(para, idx);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-opacity"
                    title="複製內容"
                  >
                    {copiedIndex === idx ? (
                      <Check className="h-3 w-3 text-emerald-400" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                </div>
                <p className="text-xs leading-relaxed whitespace-pre-wrap select-text">{para}</p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
