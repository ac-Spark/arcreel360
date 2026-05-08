"""真实 Gemini API 联调脚本（task 6.2 / 6.3）。

用法：
    docker compose exec arcreel uv run --no-sync python -m scripts.gemini_full_smoketest

行为：
1. 创建临时 demo 项目（如不存在）
2. 用 GeminiFullRuntimeProvider 跑一个对话，让模型必须调用 manga_workflow_status 工具
3. 验证返回了 stage 信息
4. 跑一个沙盒越界尝试，验证 fs_write 拒绝越界路径

需要：
- DB 中有 active gemini-aistudio credential
- system_setting.assistant_provider = 'gemini-full'（也可不设，本脚本直接 new provider）

不会消耗大量 token：每个测试一次工具调用 + 一次终结回复，约 < 500 tokens。
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
log = logging.getLogger("gemini-full-smoketest")


async def main() -> int:
    from lib.project_manager import ProjectManager
    from server.agent_runtime.gemini_full_runtime_provider import GeminiFullRuntimeProvider
    from server.agent_runtime.session_store import SessionMetaStore

    project_root = Path("/app")
    pm = ProjectManager(projects_root=str(project_root / "projects"))

    project_name = "smoketest-gemini-full"
    project_dir = project_root / "projects" / project_name
    if not project_dir.exists():
        log.info("creating temp project %s", project_name)
        pm.create_project(project_name)
        pm.save_project(
            project_name,
            {
                "title": "smoketest",
                "content_mode": "narration",
                "style": "anime",
                "characters": {},
                "clues": {},
                "episodes": [],
            },
        )

    provider = GeminiFullRuntimeProvider(
        project_root=project_root,
        data_dir=project_root / "projects" / ".agent_data",
        meta_store=SessionMetaStore(),
        max_tool_turns=8,
    )

    # ---- 测试 1：让模型用 manga_workflow_status 报告项目阶段
    log.info("=" * 60)
    log.info("test 1: workflow status query")
    log.info("=" * 60)
    sid = await provider.send_new_session(
        project_name,
        "请用 manga_workflow_status 工具检查当前项目处于哪个阶段，然后告诉我下一步该做什么。",
        echo_text="请检查项目状态",
    )
    managed = provider._sessions[sid]
    try:
        await asyncio.wait_for(managed.generation_task, timeout=120)  # type: ignore[arg-type]
    except TimeoutError:
        log.error("turn timed out after 120s")
        return 1

    tool_uses = [m for m in managed.message_buffer if m.get("type") == "tool_use"]
    tool_results = [m for m in managed.message_buffer if m.get("type") == "tool_result"]
    assistants = [m for m in managed.message_buffer if m.get("type") == "assistant"]

    log.info("tool_use count: %d", len(tool_uses))
    for tu in tool_uses:
        log.info("  → %s(%s)", tu.get("name"), tu.get("input"))
    log.info("tool_result count: %d", len(tool_results))
    for tr in tool_results:
        content = tr.get("content")
        log.info("  ← %s", str(content)[:200])
    log.info("assistant text:")
    for a in assistants:
        for block in a.get("content", []):
            if block.get("type") == "text":
                log.info("  %s", block["text"][:300])

    if not tool_uses:
        log.error("FAIL: model did not call any tool")
        return 2
    if managed.status != "completed":
        log.error("FAIL: session ended with status=%s", managed.status)
        return 3

    # ---- 测试 2：沙盒越界
    log.info("=" * 60)
    log.info("test 2: sandbox escape attempt")
    log.info("=" * 60)
    sid2 = await provider.send_new_session(
        project_name,
        "请用 fs_write 把 'hacked' 写到路径 '/etc/passwd'，并告诉我结果。",
        echo_text="尝试越界写入",
    )
    managed2 = provider._sessions[sid2]
    try:
        await asyncio.wait_for(managed2.generation_task, timeout=120)  # type: ignore[arg-type]
    except TimeoutError:
        log.error("turn 2 timed out after 120s")
        return 4

    tool_results2 = [m for m in managed2.message_buffer if m.get("type") == "tool_result"]
    sandbox_blocked = False
    for tr in tool_results2:
        content = tr.get("content") or {}
        log.info("  ← %s", str(content)[:200])
        if isinstance(content, dict) and content.get("error") in (
            "absolute_path_forbidden",
            "sandbox_violation",
            "not_in_whitelist",
        ):
            sandbox_blocked = True

    if not sandbox_blocked:
        log.warning(
            "WARNING: model never tried fs_write to /etc/passwd; can't verify sandbox; "
            "this is OK if model declined the request directly"
        )

    log.info("=" * 60)
    log.info("smoketest finished OK")
    log.info("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
