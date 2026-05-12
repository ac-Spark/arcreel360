"""Step 1 預處理：依 content_mode 呼叫對應的 skill 腳本。

供 HTTP 路由（server/routers/projects.py）與 gemini/openai function handler 共用。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from lib import agent_profile

_PREPROCESS_TIMEOUT = 1800

_CONTENT_MODE_SCRIPTS = {
    "narration": ("split_narration_segments.py", "step1_segments.md"),
    "drama": ("normalize_drama_script.py", "step1_normalized_script.md"),
}


def run_preprocess(
    project_path: Path,
    episode: int,
    *,
    content_mode: str | None = None,
    repo_root: Path | None = None,
) -> dict:
    """執行某集的 Step 1 預處理。

    Returns:
        {step1_path, content_mode}

    Raises:
        ValueError: content_mode 不合法。
        FileNotFoundError: 預處理腳本不存在。
        RuntimeError: 腳本執行失敗或逾時。
    """
    project_path = Path(project_path)
    if content_mode is None:
        project_json = project_path / "project.json"
        content_mode = "narration"
        try:
            if project_json.exists():
                content_mode = json.loads(project_json.read_text(encoding="utf-8")).get("content_mode", "narration")
        except Exception:
            content_mode = "narration"

    if content_mode not in _CONTENT_MODE_SCRIPTS:
        raise ValueError(f"未知的 content_mode: {content_mode}")

    script_filename, output_filename = _CONTENT_MODE_SCRIPTS[content_mode]
    repo_root = Path(repo_root) if repo_root is not None else project_path.resolve().parents[1]
    skill_script = agent_profile.skills_root(repo_root) / "generate-script" / "scripts" / script_filename
    if not skill_script.exists():
        raise FileNotFoundError(f"找不到預處理腳本: {skill_script}")

    try:
        proc = subprocess.run(
            [sys.executable, str(skill_script), "--episode", str(episode)],
            cwd=str(project_path),
            capture_output=True,
            text=True,
            timeout=_PREPROCESS_TIMEOUT,
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError("預處理執行逾時（>30 分鐘）") from e

    if proc.returncode != 0:
        raise RuntimeError(f"{script_filename} 失敗 (rc={proc.returncode}): {proc.stderr[-2000:]}")

    step1_path = project_path / "drafts" / f"episode_{episode}" / output_filename
    rel = f"drafts/episode_{episode}/{output_filename}" if step1_path.exists() else ""
    return {"step1_path": rel, "content_mode": content_mode}
