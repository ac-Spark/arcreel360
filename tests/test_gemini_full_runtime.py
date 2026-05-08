"""``GeminiFullRuntimeProvider`` 单元测试 — 覆盖工具循环、中断、max_turns。

策略：用 fake Gemini client（不联网），按预设脚本依次返回 functionCall 与文本。
聚焦 tool loop 行为本身，不验证 prompt 内容。
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from lib.project_manager import ProjectManager
from server.agent_runtime.gemini_full_runtime_provider import (
    GeminiFullRuntimeProvider,
    _extract_text,
    _split_response,
)
from server.agent_runtime.permission_gate import AlwaysAllowGate, Deny
from server.agent_runtime.session_store import SessionMetaStore

# ---------------------------------------------------------------------------
# Fake Gemini SDK response objects
# ---------------------------------------------------------------------------


def _make_response(*parts_spec: dict[str, Any]) -> Any:
    """构造 ``resp.candidates[0].content.parts`` 形态的对象。

    parts_spec 例：
        {"text": "hello"}
        {"function_call": {"name": "fs_read", "args": {"path": "x"}}}
    """
    parts = []
    for spec in parts_spec:
        if "text" in spec:
            parts.append(SimpleNamespace(text=spec["text"], function_call=None))
        elif "function_call" in spec:
            fc = spec["function_call"]
            parts.append(
                SimpleNamespace(
                    text=None,
                    function_call=SimpleNamespace(name=fc["name"], args=fc.get("args", {})),
                )
            )
    content = SimpleNamespace(parts=parts)
    candidate = SimpleNamespace(content=content)
    return SimpleNamespace(candidates=[candidate])


# ---------------------------------------------------------------------------
# _split_response / _extract_text
# ---------------------------------------------------------------------------


def test_split_response_text_only() -> None:
    resp = _make_response({"text": "hi"}, {"text": "there"})
    fcalls, chunks = _split_response(resp)
    assert chunks == ["hi", "there"]
    assert fcalls == []


def test_split_response_function_call() -> None:
    resp = _make_response(
        {"function_call": {"name": "fs_read", "args": {"path": "x.txt"}}},
        {"text": "trailing"},
    )
    fcalls, chunks = _split_response(resp)
    assert chunks == ["trailing"]
    assert len(fcalls) == 1
    assert fcalls[0]["name"] == "fs_read"
    assert fcalls[0]["args"] == {"path": "x.txt"}
    assert fcalls[0]["id"]  # uuid 被填上


def test_split_response_empty_candidates() -> None:
    resp = SimpleNamespace(candidates=[])
    fcalls, chunks = _split_response(resp)
    assert fcalls == [] and chunks == []


def test_extract_text_handles_str_and_blocks() -> None:
    assert _extract_text("plain") == "plain"
    assert _extract_text([{"type": "text", "text": "a"}]) == "a"
    assert _extract_text([{"type": "tool_use", "name": "x"}]) == ""
    assert _extract_text(None) == ""


# ---------------------------------------------------------------------------
# Provider tool loop（mock client）
# ---------------------------------------------------------------------------


@pytest.fixture
def provider(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> GeminiFullRuntimeProvider:
    project_root = tmp_path
    (project_root / "projects" / "demo").mkdir(parents=True)
    pm = ProjectManager(projects_root=str(project_root / "projects"))
    pm.save_project(
        "demo",
        {"title": "demo", "characters": {}, "clues": {}, "episodes": []},
    )

    meta_store = SessionMetaStore()
    p = GeminiFullRuntimeProvider(
        project_root=project_root,
        data_dir=project_root / "data",
        meta_store=meta_store,
        permission_gate=AlwaysAllowGate(),
        max_tool_turns=5,
    )

    async def fake_get_client() -> tuple[Any, str]:
        return SimpleNamespace(), "gemini-fake"

    monkeypatch.setattr(p, "_get_genai_client", fake_get_client)

    # persist 默认会真写 DB；此处替换为 noop（避免依赖 PG）
    async def _noop_persist(_sid: str, _msg: dict[str, Any]) -> None:
        pass

    monkeypatch.setattr(p, "_persist_message", _noop_persist)

    async def _noop_load(_sid: str) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(p, "_load_history", _noop_load)

    # meta_store 也用内存替身（避免触发 DB）
    class _FakeMetaStore:
        async def create(self, *a: Any, **k: Any) -> None:
            pass

        async def update_status(self, *a: Any, **k: Any) -> None:
            pass

        async def get(self, *a: Any, **k: Any) -> Any:
            return None

    monkeypatch.setattr(p, "_meta_store", _FakeMetaStore())

    return p


def _patch_gemini_calls(
    provider: GeminiFullRuntimeProvider,
    monkeypatch: pytest.MonkeyPatch,
    *responses: Any,
) -> list[list[dict[str, Any]]]:
    """让 ``_gemini_generate`` 按顺序返回 responses；返回每次调用收到的 contents 副本列表。

    同时 stub ``_gemini_stream`` 抛 AttributeError 让 provider 走回退路径，方便单测复用既有 fake response。
    """
    seen: list[list[dict[str, Any]]] = []
    queue = list(responses)

    async def fake_generate(client: Any, model: str, contents: list[dict[str, Any]]) -> Any:
        seen.append([dict(c) for c in contents])
        if not queue:
            raise RuntimeError("no more fake responses")
        return queue.pop(0)

    async def fake_stream_unsupported(*_a: Any, **_kw: Any) -> Any:
        raise AttributeError("stream not supported in fake")

    monkeypatch.setattr(provider, "_gemini_generate", fake_generate)
    monkeypatch.setattr(provider, "_gemini_stream", fake_stream_unsupported)
    return seen


class _AsyncChunks:
    """模拟 async iterator，用于 ``_gemini_stream`` 的返回。"""

    def __init__(self, chunks: list[Any]) -> None:
        self._chunks = list(chunks)

    def __aiter__(self) -> _AsyncChunks:
        return self

    async def __anext__(self) -> Any:
        if not self._chunks:
            raise StopAsyncIteration
        return self._chunks.pop(0)


def _patch_gemini_stream(
    provider: GeminiFullRuntimeProvider,
    monkeypatch: pytest.MonkeyPatch,
    *streams: list[Any],
) -> None:
    """让 ``_gemini_stream`` 按顺序返回多组 async iterator（每组对应一轮 turn）。"""
    queue = list(streams)

    async def fake_stream(client: Any, model: str, contents: list[dict[str, Any]]) -> Any:
        if not queue:
            raise RuntimeError("no more fake streams")
        return _AsyncChunks(queue.pop(0))

    monkeypatch.setattr(provider, "_gemini_stream", fake_stream)


async def _wait_generation(provider: GeminiFullRuntimeProvider, session_id: str) -> None:
    task = provider._sessions[session_id].generation_task
    assert task is not None
    await task


@pytest.mark.asyncio
async def test_single_turn_text_only_completes(
    provider: GeminiFullRuntimeProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_gemini_calls(provider, monkeypatch, _make_response({"text": "你好"}))

    sid = await provider.send_new_session("demo", "嗨", echo_text="嗨")
    assert sid.startswith("gemini-full:")

    managed = provider._sessions[sid]
    await _wait_generation(provider, sid)

    types = [m.get("type") for m in managed.message_buffer]
    assert "user" in types
    assert "assistant" in types
    # 最终 result subtype 应为 success
    result_msgs = [m for m in managed.message_buffer if m.get("type") == "result"]
    assert result_msgs and result_msgs[-1]["subtype"] == "success"
    assert managed.status == "completed"


@pytest.mark.asyncio
async def test_tool_loop_executes_fs_read(provider: GeminiFullRuntimeProvider, monkeypatch: pytest.MonkeyPatch) -> None:
    target = provider._project_root / "projects" / "demo" / "scripts"
    target.mkdir(parents=True, exist_ok=True)
    (target / "ep1.json").write_text("hello", encoding="utf-8")

    _patch_gemini_calls(
        provider,
        monkeypatch,
        _make_response({"function_call": {"name": "fs_read", "args": {"path": "scripts/ep1.json"}}}),
        _make_response({"text": "已讀完"}),
    )

    sid = await provider.send_new_session("demo", "讀檔案", echo_text="讀檔案")
    await _wait_generation(provider, sid)

    buf = provider._sessions[sid].message_buffer
    tool_uses = [m for m in buf if m.get("type") == "tool_use"]
    tool_results = [m for m in buf if m.get("type") == "tool_result"]
    assert len(tool_uses) == 1
    assert len(tool_results) == 1
    assert tool_results[0]["content"]["content"] == "hello"
    assert provider._sessions[sid].status == "completed"


@pytest.mark.asyncio
async def test_tool_loop_handles_skill_dispatch(
    provider: GeminiFullRuntimeProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_gemini_calls(
        provider,
        monkeypatch,
        _make_response(
            {
                "function_call": {
                    "name": "generate_characters",
                    "args": {
                        "characters": [
                            {"name": "小明", "description": "少年"},
                        ]
                    },
                }
            }
        ),
        _make_response({"text": "已新增小明"}),
    )

    sid = await provider.send_new_session("demo", "建角色", echo_text="建角色")
    await _wait_generation(provider, sid)

    buf = provider._sessions[sid].message_buffer
    tool_results = [m for m in buf if m.get("type") == "tool_result"]
    assert tool_results[0]["content"]["ok"] is True
    assert "小明" in tool_results[0]["content"]["added"]
    # 角色应已落入 project.json
    project = provider._project_manager.load_project("demo")
    assert "小明" in project["characters"]


@pytest.mark.asyncio
async def test_max_turns_terminates_with_error(
    provider: GeminiFullRuntimeProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 让模型每轮都吐 functionCall 不停，强制触顶
    spam = _make_response({"function_call": {"name": "fs_list", "args": {"path": "scripts"}}})
    _patch_gemini_calls(provider, monkeypatch, *([spam] * provider._max_tool_turns))

    sid = await provider.send_new_session("demo", "重複", echo_text="重複")
    await _wait_generation(provider, sid)

    buf = provider._sessions[sid].message_buffer
    result_msgs = [m for m in buf if m.get("type") == "result"]
    assert result_msgs[-1]["subtype"] == "max_turns"
    assert provider._sessions[sid].status == "error"


@pytest.mark.asyncio
async def test_permission_deny_returns_to_model(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """gate.Deny 时不应执行工具，但 session 不进入 error；deny 原因塞回 model。"""

    class DenyGate:
        def check(self, tool_name: str, args: dict[str, Any], session_id: str) -> Deny:
            return Deny("user rejected")

    project_root = tmp_path
    (project_root / "projects" / "demo").mkdir(parents=True)
    ProjectManager(projects_root=str(project_root / "projects")).save_project(
        "demo", {"title": "demo", "characters": {}, "clues": {}, "episodes": []}
    )

    p = GeminiFullRuntimeProvider(
        project_root=project_root,
        data_dir=project_root / "data",
        meta_store=SessionMetaStore(),
        permission_gate=DenyGate(),
        max_tool_turns=3,
    )

    async def fake_get_client():
        return SimpleNamespace(), "gemini-fake"

    monkeypatch.setattr(p, "_get_genai_client", fake_get_client)

    async def _noop(*_a, **_k):
        return None

    async def _empty(*_a, **_k):
        return []

    monkeypatch.setattr(p, "_persist_message", _noop)
    monkeypatch.setattr(p, "_load_history", _empty)

    class _FMS:
        async def create(self, *a, **k):
            pass

        async def update_status(self, *a, **k):
            pass

        async def get(self, *a, **k):
            return None

    monkeypatch.setattr(p, "_meta_store", _FMS())

    _patch_gemini_calls(
        p,
        monkeypatch,
        _make_response({"function_call": {"name": "fs_write", "args": {"path": "scripts/x", "content": "y"}}}),
        _make_response({"text": "好的我放弃了"}),
    )

    sid = await p.send_new_session("demo", "寫", echo_text="寫")
    await _wait_generation(p, sid)

    buf = p._sessions[sid].message_buffer
    tool_results = [m for m in buf if m.get("type") == "tool_result"]
    assert tool_results[0]["content"]["error"] == "permission_denied"
    assert tool_results[0]["content"]["reason"] == "user rejected"
    assert p._sessions[sid].status == "completed"  # 不进入 error


async def _noop_async() -> list[dict[str, Any]]:
    return []


# ---------------------------------------------------------------------------
# Streaming（_gemini_stream）
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_streaming_emits_text_deltas(
    provider: GeminiFullRuntimeProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 一轮 turn：3 个文本 chunk，无 functionCall
    _patch_gemini_stream(
        provider,
        monkeypatch,
        [
            _make_response({"text": "你"}),
            _make_response({"text": "好"}),
            _make_response({"text": "！"}),
        ],
    )

    sid = await provider.send_new_session("demo", "嗨", echo_text="嗨")
    await _wait_generation(provider, sid)

    buf = provider._sessions[sid].message_buffer
    deltas = [m for m in buf if m.get("type") == "stream_event"]
    assert len(deltas) == 3
    assert [d["delta"]["text"] for d in deltas] == ["你", "好", "！"]
    # 流结束后聚合的 assistant message 包含完整文本
    assistants = [m for m in buf if m.get("type") == "assistant"]
    assert assistants[-1]["content"][0]["text"] == "你好！"


@pytest.mark.asyncio
async def test_streaming_with_function_call_does_not_emit_text_delta(
    provider: GeminiFullRuntimeProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = provider._project_root / "projects" / "demo" / "scripts"
    target.mkdir(parents=True, exist_ok=True)
    (target / "ep1.json").write_text("ok", encoding="utf-8")

    _patch_gemini_stream(
        provider,
        monkeypatch,
        # turn 1：只返回 function call，无 text delta
        [
            _make_response({"function_call": {"name": "fs_read", "args": {"path": "scripts/ep1.json"}}}),
        ],
        # turn 2：纯文本流
        [_make_response({"text": "已讀完"})],
    )

    sid = await provider.send_new_session("demo", "讀檔案", echo_text="讀檔案")
    await _wait_generation(provider, sid)

    buf = provider._sessions[sid].message_buffer
    deltas = [m for m in buf if m.get("type") == "stream_event"]
    assert len(deltas) == 1
    assert deltas[0]["delta"]["text"] == "已讀完"
    tool_results = [m for m in buf if m.get("type") == "tool_result"]
    assert tool_results and tool_results[0]["content"]["content"] == "ok"
