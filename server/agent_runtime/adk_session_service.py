"""ADK Session Service bridging to agent_messages table."""

import json
from typing import Any, Optional
from uuid import uuid4

from google.adk.events.event import Event
from google.adk.sessions.base_session_service import BaseSessionService, GetSessionConfig, ListSessionsResponse
from google.adk.sessions.session import Session

from lib.db.repositories.agent_message_repo import AgentMessageRepository
from lib.db import safe_session_factory
from server.agent_runtime.session_store import SessionMetaStore
from server.agent_runtime.session_identity import GEMINI_FULL_PROVIDER_ID, build_external_session_id


class AgentMessagesSessionService(BaseSessionService):
    def __init__(self, project_name: str, session_factory=None):
        self.project_name = project_name
        self._session_factory = session_factory or safe_session_factory
        self._meta_store = SessionMetaStore(session_factory=self._session_factory)

    async def create_session(
        self,
        *,
        app_name: str,
        user_id: str,
        state: Optional[dict[str, Any]] = None,
        session_id: Optional[str] = None,
    ) -> Session:
        sid = session_id or build_external_session_id(GEMINI_FULL_PROVIDER_ID, uuid4().hex)
        await self._meta_store.create(self.project_name, sid)
        return Session(id=sid, app_name=app_name, user_id=user_id, state=state or {})

    async def append_event(self, session: Session, event: Event) -> Event:
        # BaseService implementation takes care of temp state delta etc
        event = await super().append_event(session, event)

        # Mapping to agent_message format
        msg = self._event_to_dict(event)

        async with self._session_factory() as db_session:
            repo = AgentMessageRepository(db_session)
            await repo.append(session.id, msg)
        return event

    async def get_session(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        config: Optional[GetSessionConfig] = None,
    ) -> Optional[Session]:
        session = Session(id=session_id, app_name=app_name, user_id=user_id)
        events = await self.list_events(session_id)
        for e in events:
            session.events.append(e)
            self._update_session_state(session, e)
        return session

    async def list_events(self, session_id: str) -> list[Event]:
        async with self._session_factory() as db_session:
            repo = AgentMessageRepository(db_session)
            msgs = await repo.list(session_id)

        events = []
        for msg in msgs:
            events.append(self._dict_to_event(msg))
        return events

    async def list_sessions(self, *, app_name: str, user_id: Optional[str] = None) -> ListSessionsResponse:
        return ListSessionsResponse(sessions=[])

    async def delete_session(self, *, app_name: str, user_id: str, session_id: str) -> None:
        async with self._session_factory() as db_session:
            repo = AgentMessageRepository(db_session)
            await repo.delete_for_session(session_id)

    def _event_to_dict(self, event: Event) -> dict[str, Any]:
        """Convert ADK event to legacy agent_messages dict format."""
        raw_dump = event.model_dump(mode="json", exclude_none=True)

        content = []
        if event.content and event.content.parts:
            for part in event.content.parts:
                if getattr(part, "text", None):
                    content.append({"type": "text", "text": part.text})

        function_calls = event.get_function_calls()
        if event.author == "user":
            primary_type = "user"
        elif function_calls:
            primary_type = "tool_use"
        elif event.get_function_responses():
            primary_type = "tool_result"
        elif event.content and any(
            getattr(part, "thought", None) or getattr(part, "thought_signature", None)
            for part in event.content.parts
            if part
        ):
            primary_type = "thinking"
        else:
            primary_type = "assistant"

        result = {
            "type": primary_type,
            "content": content,
            "adk_event": raw_dump,
            "timestamp": event.created_at.isoformat() if hasattr(event, "created_at") and event.created_at else None,
        }

        # Populate tool specific legacy fields
        if primary_type == "tool_use" and function_calls:
            call = function_calls[0]
            result.update({"name": call.name, "input": call.args, "tool_use_id": call.id})
        elif primary_type == "tool_result":
            responses = event.get_function_responses()
            if responses:
                res = responses[0]
                result.update({"tool_use_id": res.id, "content": res.response})

        return result

    def _dict_to_event(self, d: dict[str, Any]) -> Event:
        if "adk_event" in d:
            return Event.model_validate(d["adk_event"])

        # Legacy fallback
        msg_type = d.get("type")
        content_parts = []
        author = "user"

        # Handle content
        legacy_content = d.get("content")
        if isinstance(legacy_content, list):
            for block in legacy_content:
                if block.get("type") == "text":
                    content_parts.append({"text": block.get("text", "")})
        elif isinstance(legacy_content, str):
            content_parts.append({"text": legacy_content})

        if msg_type == "assistant":
            author = "model"
        elif msg_type == "tool_use":
            author = "model"
            content_parts.append(
                {
                    "function_call": {
                        "name": d.get("name", ""),
                        "args": d.get("input", {}),
                        "id": d.get("tool_use_id", ""),
                    }
                }
            )
        elif msg_type == "tool_result":
            author = "user"
            content_parts.append(
                {
                    "function_response": {
                        "name": d.get("name", ""),  # legacy might not have name here
                        "response": d.get("content", {}),
                        "id": d.get("tool_use_id", ""),
                    }
                }
            )

        if not content_parts:
            # Fallback to serializing the whole dict if no content found
            import json

            content_parts.append({"text": json.dumps(d)})

        return Event(author=author, content={"parts": content_parts})
