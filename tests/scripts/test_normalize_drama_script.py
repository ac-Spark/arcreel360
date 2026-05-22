import importlib.util
import json
import sys
from pathlib import Path

import pytest


def load_normalize_script():
    script_path = (
        Path(__file__).resolve().parents[2]
        / "agent_runtime_profile"
        / ".claude"
        / "skills"
        / "generate-script"
        / "scripts"
        / "normalize_drama_script.py"
    )
    spec = importlib.util.spec_from_file_location("normalize_drama_script", script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["normalize_drama_script"] = module
    spec.loader.exec_module(module)
    return module


normalize_drama_script = load_normalize_script()


def test_resolve_novel_text_normal(tmp_path):
    """案例 1：當 episode_2.txt 存在時，只讀取 episode_2.txt（不混入第 1 集）。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)

    (source_dir / "episode_1.txt").write_text("Episode 1 Content", encoding="utf-8")
    (source_dir / "episode_2.txt").write_text("Episode 2 Content", encoding="utf-8")
    (source_dir / "_remaining.txt").write_text("Remaining Content", encoding="utf-8")

    result = normalize_drama_script.resolve_novel_text(tmp_path, episode=2, source=None)
    assert result == "Episode 2 Content"


def _write_project(project_path, episodes):
    """寫一份最小 project.json，episodes 為 [{"episode": N}, ...]。"""
    (project_path / "project.json").write_text(
        json.dumps({"episodes": episodes}, ensure_ascii=False),
        encoding="utf-8",
    )


def test_resolve_novel_text_episode2_no_autosplit_uses_whole(tmp_path):
    """在 drama 模式下，缺 episode_2.txt 且未指定 source 時，應直接使用整本原文而不做均分。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "novel.md").write_text("甲" * 40 + "。" + "乙" * 40 + "。", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}, {"episode": 2}])

    ep1 = normalize_drama_script.resolve_novel_text(tmp_path, episode=1, source=None)
    ep2 = normalize_drama_script.resolve_novel_text(tmp_path, episode=2, source=None)

    assert ep1 == "甲" * 40 + "。" + "乙" * 40 + "。"
    assert ep2 == "甲" * 40 + "。" + "乙" * 40 + "。"


def test_resolve_novel_text_episode1_single_episode_uses_whole(tmp_path):
    """只有 1 集：整本即第 1 集。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "novel.md").write_text("整本原文內容。", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}])

    result = normalize_drama_script.resolve_novel_text(tmp_path, episode=1, source=None)
    assert result == "整本原文內容。"


def test_resolve_novel_text_multi_source_files_concatenated(tmp_path):
    """source/ 多檔：按檔名排序串接。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "01_chapter.md").write_text("第一章內容。", encoding="utf-8")
    (source_dir / "02_chapter.md").write_text("第二章內容。", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}])

    result = normalize_drama_script.resolve_novel_text(tmp_path, episode=1, source=None)
    assert result == "第一章內容。\n\n第二章內容。"


def test_resolve_novel_text_excludes_remaining_txt(tmp_path):
    """串接整本時排除 _remaining.txt（分集切分的產物）。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "novel.md").write_text("正文內容。", encoding="utf-8")
    (source_dir / "_remaining.txt").write_text("不該被串進來", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}])

    result = normalize_drama_script.resolve_novel_text(tmp_path, episode=1, source=None)
    assert result == "正文內容。"


def test_resolve_novel_text_empty_source_dir_raises(tmp_path):
    """source/ 完全沒有原文檔 → SourceNotReadyError。"""
    (tmp_path / "source").mkdir(parents=True, exist_ok=True)
    _write_project(tmp_path, [{"episode": 1}])

    with pytest.raises(normalize_drama_script.SourceNotReadyError):
        normalize_drama_script.resolve_novel_text(tmp_path, episode=1, source=None)


def test_resolve_novel_text_prefers_episode_file_over_autosplit(tmp_path):
    """episode_2.txt 存在時，仍優先用它。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "novel.md").write_text("整本不該被用。", encoding="utf-8")
    (source_dir / "episode_2.txt").write_text("第二集專屬原文。", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}, {"episode": 2}])

    result = normalize_drama_script.resolve_novel_text(tmp_path, episode=2, source=None)
    assert result == "第二集專屬原文。"


def test_resolve_novel_text_explicit_source_overrides_autosplit(tmp_path):
    """有指定 source 時，用指定的。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "novel.md").write_text("整本不該被用。", encoding="utf-8")
    (source_dir / "我指定的.txt").write_text("使用者指定的原文。", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}, {"episode": 2}])

    result = normalize_drama_script.resolve_novel_text(tmp_path, episode=2, source="source/我指定的.txt")
    assert result == "使用者指定的原文。"


def test_source_not_ready_error_is_filenotfound_subclass():
    """SourceNotReadyError 應為 FileNotFoundError 子類，沿用既有 except 分支。"""
    assert issubclass(normalize_drama_script.SourceNotReadyError, FileNotFoundError)


def test_resolve_novel_text_excludes_episode_files(tmp_path):
    """串接整本時排除 episode_{N}.txt 檔案。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "novel.md").write_text("正文內容。", encoding="utf-8")
    (source_dir / "episode_1.txt").write_text("不該被串進來", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}, {"episode": 2}])

    result = normalize_drama_script.resolve_novel_text(tmp_path, episode=2, source=None)
    assert result == "正文內容。"


def test_resolve_novel_text_explicit_source_empty_raises(tmp_path):
    """當指定的 source 為空字串時，應明確拋出 FileNotFoundError。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "novel.md").write_text("正文內容。", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}])

    with pytest.raises(FileNotFoundError) as excinfo:
        normalize_drama_script.resolve_novel_text(tmp_path, episode=1, source="")
    assert "未指定原始檔路徑" in str(excinfo.value)
