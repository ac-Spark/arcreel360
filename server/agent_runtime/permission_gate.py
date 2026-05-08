"""PreToolUse 风格的权限闸门。

每次工具执行前由 provider 调用 ``gate.check(tool_name, args, session_id)``，
返回 ``Allow`` / ``Deny`` / ``AskUser``。默认 ``AlwaysAllowGate`` 全部放行；
未来可挂载自定义实现（如前端 modal 审批）而无需改 provider。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class Allow:
    pass


@dataclass(frozen=True)
class Deny:
    reason: str


@dataclass(frozen=True)
class AskUser:
    """请求人工审批；内含给前端展示的问题。"""

    question: str


PermissionDecision = Allow | Deny | AskUser
GateCallable = Callable[[str, dict[str, Any], str], PermissionDecision | bool | str | None]
OpenAIToolHandler = Callable[[Any, dict[str, Any]], Awaitable[dict[str, Any]]]


class PermissionGate(Protocol):
    """权限闸门协议。

    实现类应是无状态的，或自行管理状态。返回 ``Deny`` 时不抛异常，
    由调用方把 ``reason`` 塞进 ``functionResponse`` 反馈给模型。
    """

    def check(
        self,
        tool_name: str,
        args: dict[str, Any],
        session_id: str,
    ) -> PermissionDecision: ...


class AlwaysAllowGate:
    """默认放行所有请求。

    适用于无审批 UI 的部署，或测试环境。
    """

    def check(
        self,
        tool_name: str,
        args: dict[str, Any],
        session_id: str,
    ) -> PermissionDecision:
        return Allow()


class CallableGate:
    """把任意可调用对象包装成 ``PermissionGate``。

    用于运行时挂载自定义逻辑（例如把前端审批结果接入）。
    """

    def __init__(self, fn: GateCallable):
        self._fn = fn

    def check(
        self,
        tool_name: str,
        args: dict[str, Any],
        session_id: str,
    ) -> PermissionDecision:
        result = self._fn(tool_name, args, session_id)
        if isinstance(result, (Allow, Deny, AskUser)):
            return result
        # 容错：把简单返回值映射到决策
        if result is True or result is None:
            return Allow()
        if result is False:
            return Deny("rejected")
        if isinstance(result, str):
            return Deny(result)
        raise TypeError(f"gate callable returned unsupported type: {type(result).__name__}")


# 默认全局 gate 实例。Provider 启动时持有此引用；
# 如需自定义，可在 service 层用 ``set_default_gate`` 替换。
_default_gate: PermissionGate = AlwaysAllowGate()


def get_default_gate() -> PermissionGate:
    return _default_gate


def set_default_gate(gate: PermissionGate) -> None:
    global _default_gate
    _default_gate = gate


def _session_id_from_openai_context(ctx: Any) -> str:
    handler_context = getattr(ctx, "context", ctx)
    session_id = getattr(handler_context, "session_id", None) or getattr(ctx, "session_id", None)
    return str(session_id or "")


def _handler_context_from_openai_context(ctx: Any) -> Any:
    return getattr(ctx, "context", ctx)


def _decision_to_denied_payload(decision: PermissionDecision, tool_name: str) -> dict[str, Any] | None:
    """把 PermissionGate 的 decision 轉成 canonical denied dict;Allow 回 None。

    所有 SDK adapter 都呼叫這個 helper,確保 deny payload 跨 provider 1:1 對齊。
    """
    if isinstance(decision, Allow):
        return None
    if isinstance(decision, Deny):
        return {
            "permission_denied": True,
            "reason": decision.reason,
            "tool": tool_name,
        }
    if isinstance(decision, AskUser):
        return {
            "permission_denied": True,
            "reason": "approval_required",
            "question": decision.question,
            "tool": tool_name,
        }
    return {
        "permission_denied": True,
        "reason": "unknown_permission_decision",
        "tool": tool_name,
    }


def as_openai_wrapper(
    gate: PermissionGate,
    tool_name: str,
) -> Callable[[OpenAIToolHandler], OpenAIToolHandler]:
    """把 OpenAI ``FunctionTool`` handler 包上 ArcReel 權限閘門。

    OpenAI Agents SDK 0.1.x 的 per-tool 攔截點是 ``on_invoke_tool``;deny 時直接
    回傳可序列化 dict,讓 SDK 當作正常 tool output 餵回模型。
    """

    def decorate(handler: OpenAIToolHandler) -> OpenAIToolHandler:
        async def wrapped(ctx: Any, args: dict[str, Any]) -> dict[str, Any]:
            decision = gate.check(tool_name, args, _session_id_from_openai_context(ctx))
            denied = _decision_to_denied_payload(decision, tool_name)
            if denied is None:
                return await handler(_handler_context_from_openai_context(ctx), args)
            return denied

        return wrapped

    return decorate


def as_adk_callback(gate: PermissionGate) -> Callable:
    """把 ArcReel 權限閘門包裝為 ADK before_tool_callback。"""

    async def before_tool_callback(tool: Any, args: dict[str, Any], tool_context: Any) -> dict[str, Any] | None:
        session = getattr(tool_context, "session", None)
        session_id = session.id if session else "unknown"
        decision = gate.check(tool.name, args, session_id)
        return _decision_to_denied_payload(decision, tool.name)

    return before_tool_callback
