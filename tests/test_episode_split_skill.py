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
