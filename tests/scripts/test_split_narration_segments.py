import importlib.util
import sys
from pathlib import Path

import pytest


def load_split_script():
    script_path = (
        Path(__file__).resolve().parents[2]
        / "agent_runtime_profile"
        / ".claude"
        / "skills"
        / "generate-script"
        / "scripts"
        / "split_narration_segments.py"
    )
    spec = importlib.util.spec_from_file_location("split_narration_segments", script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["split_narration_segments"] = module
    spec.loader.exec_module(module)
    return module


split_narration_segments = load_split_script()


def test_resolve_novel_text_normal(tmp_path):
    """案例 1：當 episode_2.txt 存在時，只讀取 episode_2.txt"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)

    (source_dir / "episode_1.txt").write_text("Episode 1 Content", encoding="utf-8")
    (source_dir / "episode_2.txt").write_text("Episode 2 Content", encoding="utf-8")
    (source_dir / "_remaining.txt").write_text("Remaining Content", encoding="utf-8")

    result = split_narration_segments.resolve_novel_text(tmp_path, episode=2, source=None)
    assert result == "Episode 2 Content"


def test_resolve_novel_text_fallback_fails(tmp_path):
    """案例 2：當 episode_2.txt 不存在時，拋出 FileNotFoundError（在舊版會 fallback 讀取整個目錄）"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)

    (source_dir / "episode_1.txt").write_text("Episode 1 Content", encoding="utf-8")
    (source_dir / "_remaining.txt").write_text("Remaining Content", encoding="utf-8")

    with pytest.raises(FileNotFoundError):
        split_narration_segments.resolve_novel_text(tmp_path, episode=2, source=None)


def test_resolve_novel_text_explicit_source(tmp_path):
    """案例 3：若指定 source 參數，應正確讀取該檔案"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)

    (source_dir / "episode_1.txt").write_text("Episode 1 Content", encoding="utf-8")

    result = split_narration_segments.resolve_novel_text(tmp_path, episode=2, source="source/episode_1.txt")
    assert result == "Episode 1 Content"

    with pytest.raises(FileNotFoundError):
        split_narration_segments.resolve_novel_text(tmp_path, episode=2, source="source/non_existing.txt")
