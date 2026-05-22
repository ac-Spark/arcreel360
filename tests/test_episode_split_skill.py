import pytest


def _make_ctx(tmp_path, content_mode="narration"):
    from lib.project_manager import ProjectManager
    from server.agent_runtime.skill_function_declarations import SkillCallContext
    from server.agent_runtime.tool_sandbox import ToolSandbox

    project_root = tmp_path / "projects"
    pm = ProjectManager(projects_root=project_root)
    pm.create_project("demo")
    pm.create_project_metadata("demo", title="t", style="anime", content_mode=content_mode)
    sandbox = ToolSandbox(project_root=project_root, project_name="demo")
    return (
        SkillCallContext(
            project_name="demo",
            sandbox=sandbox,
            project_manager=pm,
            session_id="gemini-full:test",
        ),
        pm,
        pm.get_project_path("demo"),
    )


def test_run_preprocess_unknown_content_mode_raises(tmp_path):
    from lib.episode_preprocess import run_preprocess
    from lib.project_manager import ProjectManager

    pm = ProjectManager(projects_root=tmp_path / "projects")
    pm.create_project("demo")
    pm.create_project_metadata("demo", title="t", style="anime", content_mode="narration")

    project = pm.load_project("demo")
    project["content_mode"] = "weird"
    pm.save_project("demo", project)

    with pytest.raises(ValueError, match="content_mode"):
        run_preprocess(pm.get_project_path("demo"), episode=1)


def test_run_preprocess_episode_without_split_raises_source_not_ready(tmp_path):
    """如果 source/ 內沒有任何原文，均分也無法執行 → 拋出 SourceNotReadyError。"""
    from lib import PROJECT_ROOT
    from lib.episode_preprocess import SourceNotReadyError, run_preprocess
    from lib.project_manager import ProjectManager

    pm = ProjectManager(projects_root=tmp_path / "projects")
    pm.create_project("demo")
    pm.create_project_metadata("demo", title="t", style="anime", content_mode="narration")
    project_path = pm.get_project_path("demo")
    # source/ 下沒有任何原文檔，無法進行均分
    (project_path / "source").mkdir(parents=True, exist_ok=True)

    with pytest.raises(SourceNotReadyError):
        run_preprocess(project_path, episode=2, content_mode="narration", repo_root=PROJECT_ROOT)


def test_handle_peek_split_point_success(tmp_path):
    import asyncio

    from server.agent_runtime.skill_function_declarations import _handle_peek_split_point

    ctx, _pm, project_dir = _make_ctx(tmp_path)
    (project_dir / "source" / "n.txt").write_text("甲" * 30 + "。" + "乙" * 30, encoding="utf-8")

    res = asyncio.run(_handle_peek_split_point(ctx, {"source": "source/n.txt", "target_chars": 20}))

    assert res.get("total_chars") == 61
    assert "nearby_breakpoints" in res


def test_handle_peek_split_point_missing_source(tmp_path):
    import asyncio

    from server.agent_runtime.skill_function_declarations import _handle_peek_split_point

    ctx, _pm, _project_dir = _make_ctx(tmp_path)

    res = asyncio.run(_handle_peek_split_point(ctx, {"source": "source/nope.txt", "target_chars": 5}))

    assert res.get("ok") is False
    assert res.get("error") == "not_found"


def test_handle_peek_split_point_path_escape(tmp_path):
    import asyncio

    from server.agent_runtime.skill_function_declarations import _handle_peek_split_point

    ctx, _pm, _project_dir = _make_ctx(tmp_path)

    res = asyncio.run(_handle_peek_split_point(ctx, {"source": "../../etc/passwd", "target_chars": 5}))

    assert res.get("ok") is False
    assert res.get("error") == "path_escape"


def test_handle_split_episode_success_and_persisted(tmp_path):
    import asyncio

    from server.agent_runtime.skill_function_declarations import _handle_split_episode

    ctx, pm, project_dir = _make_ctx(tmp_path)
    (project_dir / "source" / "n.txt").write_text("前半段。他離開了。後半段。", encoding="utf-8")

    res = asyncio.run(
        _handle_split_episode(
            ctx,
            {"source": "source/n.txt", "episode": 1, "target_chars": 5, "anchor": "他離開了。"},
        )
    )

    assert res.get("ok") is True
    assert res.get("episode") == 1
    assert any(ep["episode"] == 1 for ep in pm.load_project("demo").get("episodes", []))
    assert (project_dir / "source" / "episode_1.txt").exists()


def test_handle_split_episode_anchor_not_found(tmp_path):
    import asyncio

    from server.agent_runtime.skill_function_declarations import _handle_split_episode

    ctx, _pm, project_dir = _make_ctx(tmp_path)
    (project_dir / "source" / "n.txt").write_text("一些內容。", encoding="utf-8")

    res = asyncio.run(
        _handle_split_episode(
            ctx,
            {"source": "source/n.txt", "episode": 1, "target_chars": 2, "anchor": "不存在"},
        )
    )

    assert res.get("ok") is False


def test_handle_preprocess_episode_unknown_mode(tmp_path):
    import asyncio

    from server.agent_runtime.skill_function_declarations import _handle_preprocess_episode

    ctx, pm, _project_dir = _make_ctx(tmp_path)
    project = pm.load_project("demo")
    project["content_mode"] = "weird"
    pm.save_project("demo", project)

    res = asyncio.run(_handle_preprocess_episode(ctx, {"episode": 1}))

    assert res.get("ok") is False
    assert res.get("error") == "invalid_content_mode"


def test_run_preprocess_with_explicit_source(tmp_path, monkeypatch):
    import subprocess

    from lib import PROJECT_ROOT
    from lib.episode_preprocess import run_preprocess
    from lib.project_manager import ProjectManager

    pm = ProjectManager(projects_root=tmp_path / "projects")
    pm.create_project("demo")
    pm.create_project_metadata("demo", title="t", style="anime", content_mode="narration")
    project_path = pm.get_project_path("demo")

    # 模擬建立預處理輸出檔案，因為 run_preprocess 會檢查 step1_path 檔案是否存在
    output_dir = project_path / "drafts" / "episode_1"
    output_dir.mkdir(parents=True, exist_ok=True)
    step1_file = output_dir / "step1_segments.md"
    step1_file.write_text("這是自訂來源內容", encoding="utf-8")

    captured_args = []

    def mock_run(args, **kwargs):
        captured_args.extend(args)
        return subprocess.CompletedProcess(args=args, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", mock_run)

    # 執行預處理，傳入 source
    res = run_preprocess(
        project_path,
        episode=1,
        content_mode="narration",
        repo_root=PROJECT_ROOT,
        source="source/custom_source.txt",
    )

    assert res.get("content_mode") == "narration"
    assert res.get("step1_path") == "drafts/episode_1/step1_segments.md"
    assert "--source" in captured_args
    assert "source/custom_source.txt" in captured_args


def test_handle_preprocess_episode_with_source(tmp_path, monkeypatch):
    import asyncio

    import lib.episode_preprocess as ep
    from server.agent_runtime.skill_function_declarations import _handle_preprocess_episode

    ctx, pm, _project_dir = _make_ctx(tmp_path)

    captured_kwargs = {}

    def _mock_preprocess(*args, **kwargs):
        captured_kwargs.update(kwargs)
        return {"step1_path": "drafts/episode_1/step1_segments.md", "content_mode": "narration"}

    monkeypatch.setattr(ep, "run_preprocess", _mock_preprocess)

    res = asyncio.run(_handle_preprocess_episode(ctx, {"episode": 1, "source": "source/custom.txt"}))

    assert res.get("ok") is True
    assert res.get("step1_path") == "drafts/episode_1/step1_segments.md"
    assert captured_kwargs.get("source") == "source/custom.txt"
