"""Lite assistant runtime providers backed by existing text backends."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import mimetypes
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from lib.config.resolver import ConfigResolver
from lib.db import async_session_factory
from lib.text_backends.base import ImageInput, TextBackend, TextGenerationRequest
from lib.text_backends.gemini import DEFAULT_MODEL as GEMINI_DEFAULT_MODEL
from lib.text_backends.gemini import GeminiTextBackend
from lib.text_backends.openai import DEFAULT_MODEL as OPENAI_DEFAULT_MODEL
from lib.text_backends.openai import OpenAITextBackend
from server.agent_runtime.models import SessionMeta, SessionStatus
from server.agent_runtime.runtime_provider import (
    AssistantPrompt,
    AssistantProviderCapabilities,
    AssistantRuntimeProvider,
    UnsupportedCapabilityError,
)
from server.agent_runtime.session_identity import (
    GEMINI_LITE_PROVIDER_ID,
    OPENAI_LITE_PROVIDER_ID,
    build_external_session_id,
)
from server.agent_runtime.session_store import SessionMetaStore

logger = logging.getLogger(__name__)


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


_PERSONA_PROMPT = """## 身份

你是 ArcReel 智能体，一个专业的 AI 视频内容创作助手。你的职责是将小说转化为可发布的短视频内容。

## 行为准则

- 主动引导用户完成视频创作工作流，而不仅仅被动回答问题
- 遇到不确定的创作决策时，向用户提出选项并给出建议，而不是自行决定
- 你是用户的视频制作搭档，专业、友善、高效"""


@dataclass
class LiteManagedSession:
    session_id: str
    project_name: str
    status: SessionStatus = "idle"
    message_buffer: list[dict[str, Any]] = field(default_factory=list)
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    pending_questions: list[dict[str, Any]] = field(default_factory=list)
    generation_task: asyncio.Task | None = None

    def add_message(self, message: dict[str, Any]) -> None:
        self.message_buffer.append(message)
        if len(self.message_buffer) > 200:
            self.message_buffer.pop(0)
        stale: list[asyncio.Queue] = []
        for queue in self.subscribers:
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                stale.append(queue)
        for queue in stale:
            self.subscribers.discard(queue)


class BaseTextBackendRuntimeProvider(AssistantRuntimeProvider):
    """In-memory lite runtime using the repo's existing text backend abstraction."""

    def __init__(
        self,
        *,
        provider_id: str,
        capabilities: AssistantProviderCapabilities,
        project_root: Path,
        data_dir: Path,
        meta_store: SessionMetaStore,
    ):
        self._provider_id = provider_id
        self._capabilities = capabilities
        self._project_root = Path(project_root)
        self._data_dir = Path(data_dir)
        self._meta_store = meta_store
        self._resolver = ConfigResolver(async_session_factory)
        self._attachments_dir = self._data_dir / "lite_runtime_attachments" / provider_id
        self._attachments_dir.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, LiteManagedSession] = {}

    @property
    def provider_id(self) -> str:
        return self._provider_id

    @property
    def capabilities(self) -> AssistantProviderCapabilities:
        return self._capabilities

    async def send_new_session(
        self,
        project_name: str,
        prompt: AssistantPrompt,
        *,
        echo_text: str | None = None,
        echo_content: list[dict[str, Any]] | None = None,
    ) -> str:
        session_id = build_external_session_id(self.provider_id, uuid4().hex)
        await self._meta_store.create(project_name, session_id)
        managed = LiteManagedSession(session_id=session_id, project_name=project_name)
        self._sessions[session_id] = managed
        await self._start_generation(managed, prompt, echo_text=echo_text, echo_content=echo_content)
        return session_id

    async def send_message(
        self,
        session_id: str,
        prompt: AssistantPrompt,
        *,
        echo_text: str | None = None,
        echo_content: list[dict[str, Any]] | None = None,
        meta: SessionMeta | None = None,
    ) -> None:
        managed = self._sessions.get(session_id)
        if managed is None:
            existing = meta or await self._meta_store.get(session_id)
            if existing is not None:
                raise UnsupportedCapabilityError(
                    self.provider_id,
                    "resume",
                    "lite provider sessions currently do not survive process restarts",
                )
            raise FileNotFoundError(f"session not found: {session_id}")
        await self._start_generation(managed, prompt, echo_text=echo_text, echo_content=echo_content)

    async def _start_generation(
        self,
        managed: LiteManagedSession,
        prompt: AssistantPrompt,
        *,
        echo_text: str | None,
        echo_content: list[dict[str, Any]] | None,
    ) -> None:
        if managed.status == "running":
            raise ValueError("会话正在处理中，请等待当前回复完成后再发送新消息")

        display_text = echo_text or (prompt if isinstance(prompt, str) else "")
        managed.status = "running"
        await self._meta_store.update_status(managed.session_id, "running")
        managed.add_message(self._build_user_echo_message(display_text, echo_content))

        managed.generation_task = asyncio.create_task(
            self._run_generation(managed, prompt, echo_text=echo_text, echo_content=echo_content)
        )

    async def _run_generation(
        self,
        managed: LiteManagedSession,
        prompt: AssistantPrompt,
        *,
        echo_text: str | None,
        echo_content: list[dict[str, Any]] | None,
    ) -> None:
        try:
            backend = await self._create_backend(project_name=managed.project_name)
            request = await self._build_request(
                managed=managed,
                backend=backend,
                prompt=prompt,
                echo_text=echo_text,
                echo_content=echo_content,
            )
            result = await backend.generate(request)
            managed.add_message(
                {
                    "type": "assistant",
                    "content": [{"type": "text", "text": result.text}],
                    "timestamp": _utc_now_iso(),
                    "uuid": uuid4().hex,
                    "provider": self.provider_id,
                    "model": result.model,
                }
            )
            managed.add_message(
                {
                    "type": "result",
                    "subtype": "success",
                    "is_error": False,
                    "timestamp": _utc_now_iso(),
                    "provider": self.provider_id,
                    "model": result.model,
                }
            )
            managed.status = "completed"
            await self._meta_store.update_status(managed.session_id, "completed")
            managed.add_message(self._build_runtime_status_message(managed.session_id, managed.status))
        except asyncio.CancelledError:
            managed.status = "interrupted"
            await self._meta_store.update_status(managed.session_id, "interrupted")
            managed.add_message(
                {
                    "type": "result",
                    "subtype": "error_interrupt",
                    "is_error": True,
                    "timestamp": _utc_now_iso(),
                    "provider": self.provider_id,
                }
            )
            managed.add_message(self._build_runtime_status_message(managed.session_id, managed.status))
            raise
        except Exception as exc:
            logger.exception("lite provider generation failed provider=%s session=%s", self.provider_id, managed.session_id)
            managed.status = "error"
            await self._meta_store.update_status(managed.session_id, "error")
            managed.add_message(
                {
                    "type": "result",
                    "subtype": "error_generation",
                    "is_error": True,
                    "timestamp": _utc_now_iso(),
                    "provider": self.provider_id,
                    "error": str(exc),
                }
            )
            managed.add_message(self._build_runtime_status_message(managed.session_id, managed.status))
        finally:
            managed.generation_task = None

    async def _build_request(
        self,
        *,
        managed: LiteManagedSession,
        backend: TextBackend,
        prompt: AssistantPrompt,
        echo_text: str | None,
        echo_content: list[dict[str, Any]] | None,
    ) -> TextGenerationRequest:
        prompt_text = self._extract_prompt_text(prompt, echo_text, echo_content)
        images = await self._extract_images(managed, echo_content)
        return TextGenerationRequest(
            prompt=prompt_text,
            images=images or None,
            system_prompt=self._build_system_prompt(managed.project_name),
        )

    def _extract_prompt_text(
        self,
        prompt: AssistantPrompt,
        echo_text: str | None,
        echo_content: list[dict[str, Any]] | None,
    ) -> str:
        if echo_text and echo_text.strip():
            return echo_text.strip()
        if isinstance(prompt, str) and prompt.strip():
            return prompt.strip()
        for block in echo_content or []:
            if isinstance(block, dict) and block.get("type") == "text":
                text = str(block.get("text") or "").strip()
                if text:
                    return text
        return ""

    async def _extract_images(
        self,
        managed: LiteManagedSession,
        echo_content: list[dict[str, Any]] | None,
    ) -> list[ImageInput]:
        inputs: list[ImageInput] = []
        if not echo_content:
            return inputs

        session_dir = self._attachments_dir / managed.session_id.replace(":", "_")
        session_dir.mkdir(parents=True, exist_ok=True)

        for index, block in enumerate(echo_content):
            if not isinstance(block, dict) or block.get("type") != "image":
                continue
            source = block.get("source") or {}
            if not isinstance(source, dict) or source.get("type") != "base64":
                continue
            data = source.get("data")
            media_type = str(source.get("media_type") or "image/png")
            if not isinstance(data, str) or not data.strip():
                continue
            suffix = mimetypes.guess_extension(media_type) or ".img"
            image_path = session_dir / f"image_{index}{suffix}"
            image_path.write_bytes(base64.b64decode(data))
            inputs.append(ImageInput(path=image_path))
        return inputs

    def _build_system_prompt(self, project_name: str) -> str:
        project_context = self._build_project_context(project_name)
        return f"{_PERSONA_PROMPT}\n\n{project_context}" if project_context else _PERSONA_PROMPT

    def _build_project_context(self, project_name: str) -> str:
        project_json = self._project_root / "projects" / project_name / "project.json"
        if not project_json.exists():
            return ""
        try:
            import json

            data = json.loads(project_json.read_text(encoding="utf-8"))
        except Exception:
            logger.warning("failed to read project context for %s", project_name, exc_info=True)
            return ""
        if not isinstance(data, dict):
            return ""

        parts = ["## 当前项目上下文", "", f"- 项目标识：{project_name}"]
        if title := data.get("title"):
            parts.append(f"- 项目标题：{title}")
        if mode := data.get("content_mode"):
            parts.append(f"- 内容模式：{mode}")
        if style := data.get("style"):
            parts.append(f"- 视觉风格：{style}")
        if style_desc := data.get("style_description"):
            parts.append(f"- 风格描述：{style_desc}")
        return "\n".join(parts)

    def _build_user_echo_message(
        self,
        display_text: str,
        echo_content: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        content = echo_content or [{"type": "text", "text": display_text}]
        return {
            "type": "user",
            "content": content,
            "timestamp": _utc_now_iso(),
            "local_echo": True,
            "uuid": uuid4().hex,
        }

    def _build_runtime_status_message(self, session_id: str, status: SessionStatus) -> dict[str, Any]:
        return {
            "type": "runtime_status",
            "session_id": session_id,
            "status": status,
            "timestamp": _utc_now_iso(),
            "provider": self.provider_id,
        }

    async def interrupt_session(self, session_id: str) -> SessionStatus:
        managed = self._sessions.get(session_id)
        if managed is None:
            meta = await self._meta_store.get(session_id)
            if meta is None:
                raise FileNotFoundError(f"session not found: {session_id}")
            return meta.status
        if managed.generation_task and not managed.generation_task.done():
            managed.generation_task.cancel()
            with contextlib.suppress(Exception):
                await managed.generation_task
        return managed.status

    async def close_session(self, session_id: str, *, reason: str = "session closed") -> None:
        managed = self._sessions.pop(session_id, None)
        if managed and managed.generation_task and not managed.generation_task.done():
            managed.generation_task.cancel()
            with contextlib.suppress(Exception):
                await managed.generation_task

    async def answer_user_question(
        self,
        session_id: str,
        question_id: str,
        answers: dict[str, str],
    ) -> None:
        raise UnsupportedCapabilityError(self.provider_id, "ask_user_question")

    async def subscribe(self, session_id: str, replay_buffer: bool = True) -> asyncio.Queue:
        managed = self._sessions.get(session_id)
        if managed is None:
            raise UnsupportedCapabilityError(
                self.provider_id,
                "resume",
                "lite provider cannot subscribe to a session that is not resident in memory",
            )
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        if replay_buffer:
            for message in managed.message_buffer:
                try:
                    queue.put_nowait(message)
                except asyncio.QueueFull:
                    break
        managed.subscribers.add(queue)
        return queue

    async def unsubscribe(self, session_id: str, queue: asyncio.Queue) -> None:
        managed = self._sessions.get(session_id)
        if managed:
            managed.subscribers.discard(queue)

    async def get_status(self, session_id: str) -> SessionStatus | None:
        managed = self._sessions.get(session_id)
        if managed is not None:
            return managed.status
        meta = await self._meta_store.get(session_id)
        return meta.status if meta else None

    def get_live_status(self, session_id: str) -> SessionStatus | None:
        managed = self._sessions.get(session_id)
        return managed.status if managed is not None else None

    def has_live_session(self, session_id: str) -> bool:
        return session_id in self._sessions

    def get_buffered_messages(self, session_id: str) -> list[dict[str, Any]]:
        managed = self._sessions.get(session_id)
        if managed is None:
            return []
        return list(managed.message_buffer)

    async def read_history_messages(self, session_id: str) -> list[dict[str, Any]]:
        return self.get_buffered_messages(session_id)

    async def get_pending_questions_snapshot(self, session_id: str) -> list[dict[str, Any]]:
        managed = self._sessions.get(session_id)
        if managed is None:
            return []
        return list(managed.pending_questions)

    async def shutdown_gracefully(self, timeout: float = 30.0) -> None:
        for session_id in list(self._sessions.keys()):
            await self.close_session(session_id, reason="shutdown")

    async def _create_backend(self, project_name: str) -> TextBackend:
        raise NotImplementedError


class GeminiLiteProvider(BaseTextBackendRuntimeProvider):
    def __init__(self, *, project_root: Path, data_dir: Path, meta_store: SessionMetaStore):
        super().__init__(
            provider_id=GEMINI_LITE_PROVIDER_ID,
            capabilities=AssistantProviderCapabilities(
                provider=GEMINI_LITE_PROVIDER_ID,
                tier="lite",
                supports_streaming=True,
                supports_images=True,
                supports_tool_calls=False,
                supports_interrupt=True,
                supports_resume=False,
                supports_subagents=False,
                supports_permission_hooks=False,
            ),
            project_root=project_root,
            data_dir=data_dir,
            meta_store=meta_store,
        )

    async def _create_backend(self, project_name: str) -> TextBackend:
        async with self._resolver.session() as resolver:
            provider_id, model_id = await resolver.default_text_backend()
            aistudio = await resolver.provider_config("gemini-aistudio")
            vertex = await resolver.provider_config("gemini-vertex")

        if provider_id == "gemini-vertex":
            return GeminiTextBackend(model=model_id or GEMINI_DEFAULT_MODEL, backend="vertex", gcs_bucket=vertex.get("gcs_bucket"))

        model = model_id if provider_id == "gemini-aistudio" else GEMINI_DEFAULT_MODEL
        return GeminiTextBackend(
            api_key=aistudio.get("api_key"),
            model=model,
            backend="aistudio",
            base_url=aistudio.get("base_url"),
        )


class OpenAILiteProvider(BaseTextBackendRuntimeProvider):
    def __init__(self, *, project_root: Path, data_dir: Path, meta_store: SessionMetaStore):
        super().__init__(
            provider_id=OPENAI_LITE_PROVIDER_ID,
            capabilities=AssistantProviderCapabilities(
                provider=OPENAI_LITE_PROVIDER_ID,
                tier="lite",
                supports_streaming=True,
                supports_images=True,
                supports_tool_calls=False,
                supports_interrupt=True,
                supports_resume=False,
                supports_subagents=False,
                supports_permission_hooks=False,
            ),
            project_root=project_root,
            data_dir=data_dir,
            meta_store=meta_store,
        )

    async def _create_backend(self, project_name: str) -> TextBackend:
        async with self._resolver.session() as resolver:
            provider_id, model_id = await resolver.default_text_backend()
            config = await resolver.provider_config("openai")

        model = model_id if provider_id == "openai" else OPENAI_DEFAULT_MODEL
        return OpenAITextBackend(
            api_key=config.get("api_key"),
            model=model,
            base_url=config.get("base_url"),
        )