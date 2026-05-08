"""``server.agent_runtime.permission_gate`` 单元测试。

覆盖 spec ``assistant-tool-sandbox`` 中权限闸门要求：默认放行、Deny 不抛异常、
自定义实现可挂载、Deny 携带 reason。
"""

from __future__ import annotations

from typing import Any

import pytest

from server.agent_runtime.permission_gate import (
    Allow,
    AlwaysAllowGate,
    AskUser,
    CallableGate,
    Deny,
    PermissionGate,
    get_default_gate,
    set_default_gate,
)


def test_always_allow_gate_returns_allow() -> None:
    gate = AlwaysAllowGate()
    decision = gate.check("fs_write", {"path": "scripts/x.json"}, "session-1")
    assert isinstance(decision, Allow)


def test_default_gate_is_always_allow() -> None:
    assert isinstance(get_default_gate(), AlwaysAllowGate)


def test_set_default_gate_replaces_singleton() -> None:
    class _Custom:
        def check(self, tool_name: str, args: dict[str, Any], session_id: str) -> Deny:
            return Deny("nope")

    original = get_default_gate()
    try:
        set_default_gate(_Custom())
        decision = get_default_gate().check("fs_read", {}, "s1")
        assert isinstance(decision, Deny)
        assert decision.reason == "nope"
    finally:
        set_default_gate(original)


def test_callable_gate_with_decision_object() -> None:
    gate = CallableGate(lambda tool, args, sid: Deny(f"reject {tool}"))
    decision = gate.check("fs_write", {}, "s1")
    assert isinstance(decision, Deny)
    assert decision.reason == "reject fs_write"


def test_callable_gate_maps_truthy_to_allow() -> None:
    gate = CallableGate(lambda *_args, **_kw: True)
    assert isinstance(gate.check("fs_read", {}, "s1"), Allow)


def test_callable_gate_maps_none_to_allow() -> None:
    gate = CallableGate(lambda *_args, **_kw: None)
    assert isinstance(gate.check("fs_read", {}, "s1"), Allow)


def test_callable_gate_maps_false_to_deny() -> None:
    gate = CallableGate(lambda *_args, **_kw: False)
    decision = gate.check("fs_write", {}, "s1")
    assert isinstance(decision, Deny)
    assert decision.reason == "rejected"


def test_callable_gate_maps_string_to_deny_with_reason() -> None:
    gate = CallableGate(lambda *_args, **_kw: "no write during freeze")
    decision = gate.check("fs_write", {}, "s1")
    assert isinstance(decision, Deny)
    assert decision.reason == "no write during freeze"


def test_callable_gate_passthrough_ask_user() -> None:
    gate = CallableGate(lambda *_args, **_kw: AskUser("approve fs_write?"))
    decision = gate.check("fs_write", {}, "s1")
    assert isinstance(decision, AskUser)
    assert decision.question == "approve fs_write?"


def test_callable_gate_unsupported_return_raises() -> None:
    gate = CallableGate(lambda *_args, **_kw: 42)
    with pytest.raises(TypeError):
        gate.check("fs_write", {}, "s1")


def test_protocol_compliance() -> None:
    """Both built-in implementations must satisfy the PermissionGate protocol."""
    instances: list[PermissionGate] = [AlwaysAllowGate(), CallableGate(lambda *a, **k: True)]
    for gate in instances:
        decision = gate.check("any_tool", {"k": "v"}, "session-x")
        assert isinstance(decision, (Allow, Deny, AskUser))
