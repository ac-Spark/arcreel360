import importlib.util
import json
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


def _write_project(project_path, episodes):
    """寫一份最小 project.json，episodes 為 [{"episode": N}, ...]。"""
    (project_path / "project.json").write_text(
        json.dumps({"episodes": episodes}, ensure_ascii=False),
        encoding="utf-8",
    )


def test_resolve_novel_text_episode2_auto_split_from_whole(tmp_path):
    """缺 episode_2.txt 且未指定 source：整本按 2 集均分，第 2 集取後半。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "novel.md").write_text("甲" * 40 + "。" + "乙" * 40 + "。", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}, {"episode": 2}])

    ep1 = split_narration_segments.resolve_novel_text(tmp_path, episode=1, source=None)
    ep2 = split_narration_segments.resolve_novel_text(tmp_path, episode=2, source=None)

    assert ep1 + ep2 == "甲" * 40 + "。" + "乙" * 40 + "。"
    assert ep1 and ep2


def test_resolve_novel_text_episode1_single_episode_uses_whole(tmp_path):
    """只有 1 集：整本即第 1 集。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "novel.md").write_text("整本原文內容。", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}])

    result = split_narration_segments.resolve_novel_text(tmp_path, episode=1, source=None)
    assert result == "整本原文內容。"


def test_resolve_novel_text_multi_source_files_concatenated(tmp_path):
    """source/ 多檔：按檔名排序串接後再均分。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "01_chapter.md").write_text("第一章內容。", encoding="utf-8")
    (source_dir / "02_chapter.md").write_text("第二章內容。", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}])

    result = split_narration_segments.resolve_novel_text(tmp_path, episode=1, source=None)
    assert result == "第一章內容。\n\n第二章內容。"


def test_resolve_novel_text_excludes_remaining_txt(tmp_path):
    """串接整本時排除 _remaining.txt（分集切分的產物）。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "novel.md").write_text("正文內容。", encoding="utf-8")
    (source_dir / "_remaining.txt").write_text("不該被串進來", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}])

    result = split_narration_segments.resolve_novel_text(tmp_path, episode=1, source=None)
    assert result == "正文內容。"


def test_resolve_novel_text_empty_source_dir_raises(tmp_path):
    """source/ 完全沒有原文檔 → SourceNotReadyError。"""
    (tmp_path / "source").mkdir(parents=True, exist_ok=True)
    _write_project(tmp_path, [{"episode": 1}])

    with pytest.raises(split_narration_segments.SourceNotReadyError):
        split_narration_segments.resolve_novel_text(tmp_path, episode=1, source=None)


def test_resolve_novel_text_prefers_episode_file_over_autosplit(tmp_path):
    """episode_2.txt 存在時，仍優先用它，不走均分。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "novel.md").write_text("整本不該被用。", encoding="utf-8")
    (source_dir / "episode_2.txt").write_text("第二集專屬原文。", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}, {"episode": 2}])

    result = split_narration_segments.resolve_novel_text(tmp_path, episode=2, source=None)
    assert result == "第二集專屬原文。"


def test_resolve_novel_text_explicit_source_overrides_autosplit(tmp_path):
    """有指定 source 時，用指定的，不走均分（即使整本存在）。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "novel.md").write_text("整本不該被用。", encoding="utf-8")
    (source_dir / "我指定的.txt").write_text("使用者指定的原文。", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}, {"episode": 2}])

    result = split_narration_segments.resolve_novel_text(tmp_path, episode=2, source="source/我指定的.txt")
    assert result == "使用者指定的原文。"


def test_source_not_ready_error_is_filenotfound_subclass():
    """SourceNotReadyError 應為 FileNotFoundError 子類，沿用既有 except 分支。"""
    assert issubclass(split_narration_segments.SourceNotReadyError, FileNotFoundError)


def test_resolve_novel_text_excludes_episode_files(tmp_path):
    """串接整本時排除 episode_{N}.txt 檔案。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "novel.md").write_text("正文內容。", encoding="utf-8")
    (source_dir / "episode_1.txt").write_text("不該被串進來", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 2}])

    result = split_narration_segments.resolve_novel_text(tmp_path, episode=2, source=None)
    assert result == "正文內容。"


def test_resolve_novel_text_autosplit_empty_raises(tmp_path):
    """當均分出的片段為空時拋出 SourceNotReadyError。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    # 原文非常短，均分成 5 集，後段集數的內容會是空的
    (source_dir / "novel.md").write_text("很短的小說。", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}, {"episode": 2}, {"episode": 3}, {"episode": 4}, {"episode": 5}])

    with pytest.raises(split_narration_segments.SourceNotReadyError) as excinfo:
        split_narration_segments.resolve_novel_text(tmp_path, episode=5, source=None)
    assert "均分原文後第 5 集的內容為空" in str(excinfo.value)


    with pytest.raises(FileNotFoundError) as excinfo:
        split_narration_segments.resolve_novel_text(tmp_path, episode=1, source="")
    assert "未指定原始檔路徑" in str(excinfo.value)


def test_resolve_novel_text_multiple_explicit_sources_concatenated(tmp_path):
    """有指定複數 source 檔案時，應依序讀取並串接內容。"""
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "part1.txt").write_text("這是第一章內容。", encoding="utf-8")
    (source_dir / "part2.txt").write_text("這是第二章內容。", encoding="utf-8")
    _write_project(tmp_path, [{"episode": 1}])

    result = split_narration_segments.resolve_novel_text(
        tmp_path, episode=1, source="source/part1.txt,source/part2.txt"
    )
    assert result == "這是第一章內容。\n\n這是第二章內容。"

