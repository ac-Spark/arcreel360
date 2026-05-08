import pytest
import json
from uuid import uuid4
from google.adk.events.event import Event
from google.adk.sessions.session import Session
from server.agent_runtime.adk_session_service import AgentMessagesSessionService
from lib.db.repositories.agent_message_repo import AgentMessageRepository

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from lib.db.base import Base


@pytest.fixture
async def session_service():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    service = AgentMessagesSessionService("test_project", session_factory=factory)
    yield service
    await engine.dispose()


@pytest.mark.asyncio
async def test_session_creation(session_service):
    session = await session_service.create_session(app_name="test_app", user_id="test_user")
    assert session.id.startswith("gemini-full:")


@pytest.mark.asyncio
async def test_append_and_list_event(session_service):
    session = await session_service.create_session(app_name="test_app", user_id="test_user")

    event = Event(author="user", content={"parts": [{"text": "hello"}]})
    await session_service.append_event(session, event)

    events = await session_service.list_events(session.id)
    assert len(events) == 1
    assert events[0].id == event.id
    assert events[0].content.parts[0].text == "hello"


@pytest.mark.asyncio
async def test_parallel_function_call(session_service):
    session = await session_service.create_session(app_name="test_app", user_id="test_user")

    event = Event(
        author="agent",
        content={
            "parts": [
                {"function_call": {"name": "tool1", "args": {"a": 1}}},
                {"function_call": {"name": "tool2", "args": {"b": 2}}},
            ]
        },
    )
    await session_service.append_event(session, event)

    events = await session_service.list_events(session.id)
    assert len(events) == 1
    fcalls = events[0].get_function_calls()
    assert len(fcalls) == 2
    assert fcalls[0].name == "tool1"
    assert fcalls[1].name == "tool2"


@pytest.mark.asyncio
async def test_tool_error_event(session_service):
    session = await session_service.create_session(app_name="test_app", user_id="test_user")
    event = Event(
        author="user",
        content={"parts": [{"function_response": {"name": "tool1", "response": {"error": "permission_denied"}}}]},
    )
    await session_service.append_event(session, event)

    events = await session_service.list_events(session.id)
    assert len(events) == 1
    fresps = events[0].get_function_responses()
    assert len(fresps) == 1
    assert fresps[0].name == "tool1"
    assert fresps[0].response["error"] == "permission_denied"


@pytest.mark.asyncio
async def test_unknown_event_fallback(session_service):
    # Test _dict_to_event fallback
    event = session_service._dict_to_event({"type": "unknown_legacy_format", "something": "else"})
    assert event.author == "user"
    assert "unknown_legacy_format" in event.content.parts[0].text
