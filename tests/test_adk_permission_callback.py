import pytest
from unittest.mock import Mock

from server.agent_runtime.permission_gate import Allow, Deny, AskUser, PermissionGate, AlwaysAllowGate, as_adk_callback


@pytest.fixture
def mock_tool():
    tool = Mock()
    tool.name = "test_tool"
    return tool


@pytest.fixture
def mock_context():
    ctx = Mock()
    ctx.session.id = "test_session_id"
    return ctx


@pytest.mark.asyncio
async def test_always_allow_gate(mock_tool, mock_context):
    gate = AlwaysAllowGate()
    callback = as_adk_callback(gate)

    result = await callback(mock_tool, {"arg": 1}, mock_context)
    assert result is None


@pytest.mark.asyncio
async def test_deny_gate(mock_tool, mock_context):
    gate = Mock(spec=PermissionGate)
    gate.check.return_value = Deny("test reason")

    callback = as_adk_callback(gate)
    result = await callback(mock_tool, {"arg": 1}, mock_context)

    assert result == {"permission_denied": True, "reason": "test reason", "tool": "test_tool"}


@pytest.mark.asyncio
async def test_ask_user_gate(mock_tool, mock_context):
    gate = Mock(spec=PermissionGate)
    gate.check.return_value = AskUser("are you sure?")

    callback = as_adk_callback(gate)
    result = await callback(mock_tool, {"arg": 1}, mock_context)

    assert result == {
        "permission_denied": True,
        "reason": "approval_required",
        "question": "are you sure?",
        "tool": "test_tool",
    }
