import { useEffect, useState, useCallback } from "react";
import { API } from "@/api";

interface FinalVideoCardProps {
  projectName: string;
  episode: number;
}

interface OutputFile {
  name: string;
  size: number;
  url: string;
}

export function FinalVideoCard({ projectName, episode }: FinalVideoCardProps) {
  const [file, setFile] = useState<OutputFile | null>(null);
  const [loading, setLoading] = useState(true);

  const targetName = `episode_${episode}_final.mp4`;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await API.listFiles(projectName);
      const found = (res.files?.output ?? []).find((f) => f.name === targetName) ?? null;
      setFile(found);
    } catch {
      setFile(null);
    } finally {
      setLoading(false);
    }
  }, [projectName, targetName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="mt-6 rounded-xl border border-gray-800 bg-gray-950/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-gray-100">最終成片</div>
          <div className="text-xs text-gray-500">{targetName}</div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-xs text-gray-400 hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 rounded px-2 py-1"
        >
          重新整理
        </button>
      </div>

      {loading ? (
        <div className="text-xs text-gray-500">載入中…</div>
      ) : file ? (
        <div className="space-y-2">
          <video
            key={file.url}
            controls
            preload="metadata"
            className="w-full rounded-lg bg-black"
            src={API.getFileUrl(projectName, `output/${file.name}`)}
          />
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>{(file.size / 1024 / 1024).toFixed(1)} MB</span>
            <a
              href={API.getFileUrl(projectName, `output/${file.name}`)}
              download={file.name}
              className="text-indigo-400 hover:text-indigo-300"
            >
              下載
            </a>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-4 text-xs text-gray-500">
          尚未產生成片。請在助手對話中執行合成（compose_video），或使用 ffmpeg 拼接 videos/ 目錄下的場景影片。
        </div>
      )}
    </div>
  );
}
