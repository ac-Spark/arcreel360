"""Gemini full-tier assistant runtime provider.

工作流模式 provider：基于 Gemini 原生 function calling 的工具循环。

设计要点（与 lite 的差异）：
- ``capabilities.tier = "full"``，所有 supports_* 为 True。
- ``send_new_session`` 创建 ``gemini-full:<uuid>`` session。
- ``_run_generation`` 不再是「prompt → text → 完成」一次过；
  改为多轮循环：模型可吐 ``functionCall`` → 本地执行（沙盒/skill 派发）→ 把
  ``functionResponse`` 喂回模型 → 直到模型给出无 functionCall 的纯文本响应或达到上限。
- 工具调用与结果以 ``tool_use`` / ``tool_result`` message type 落库（agent_messages 表）。
- 复用 ``BaseTextBackendRuntimeProvider`` 的 session 生命周期 / persist / subscribe / 中断逻辑。

实现遵循 ``openspec/changes/add-gemini-full-runtime/specs/gemini-full-runtime/``。
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from lib.project_manager import ProjectManager
from server.agent_runtime.permission_gate import (
    Allow,
    AskUser,
    Deny,
    PermissionGate,
    get_default_gate,
)
from server.agent_runtime.runtime_provider import (
    AssistantPrompt,
    AssistantProviderCapabilities,
)
from server.agent_runtime.session_identity import (
    GEMINI_FULL_PROVIDER_ID,
    build_external_session_id,
)
from server.agent_runtime.session_store import SessionMetaStore
from server.agent_runtime.skill_function_declarations import (
    SKILL_DECLARATIONS,
    SkillCallContext,
    run_subagent,
)
from server.agent_runtime.text_backend_runtime_provider import (
    BaseTextBackendRuntimeProvider,
    LiteManagedSession,
)
from server.agent_runtime.tool_sandbox import (
    ToolSandbox,
    fs_list,
    fs_read,
    fs_write,
)

logger = logging.getLogger(__name__)


# 工具循环最大轮数（避免模型陷入无限调用）
MAX_TOOL_TURNS = 20


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# fs_* 工具的 FunctionDeclaration（不放在 skill_function_declarations，因为它们是
# 通用 IO 工具不属于 skill 体系）
# ---------------------------------------------------------------------------

FS_READ_DECLARATION = {
    "name": "fs_read",
    "description": "读取项目内文本文件。路径相对于项目根，必须落在白名单子目录（source/scripts/characters/clues/storyboards/videos/drafts/output/）或 project.json。",
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "项目内相对路径"},
            "max_bytes": {
                "type": "integer",
                "description": "最大字节数，默认 1 MiB",
            },
        },
        "required": ["path"],
    },
}

FS_WRITE_DECLARATION = {
    "name": "fs_write",
    "description": "写入项目内文本文件。仅允许白名单路径，单文件 ≤ 10 MiB。",
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "content": {"type": "string"},
            "mode": {
                "type": "string",
                "enum": ["overwrite", "create"],
                "description": "默认 overwrite；create 在文件已存在时拒绝",
            },
        },
        "required": ["path", "content"],
    },
}

FS_LIST_DECLARATION = {
    "name": "fs_list",
    "description": "列出白名单目录下的直接子项（不递归，过滤隐藏文件）。",
    "parameters": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
}


def _build_tool_payload() -> list[dict[str, Any]]:
    """构造 Gemini ``Tool(function_declarations=[...])`` 的 plain dict 形式。"""
    return [
        FS_READ_DECLARATION,
        FS_WRITE_DECLARATION,
        FS_LIST_DECLARATION,
        *(d.to_gemini() for d in SKILL_DECLARATIONS),
    ]


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class GeminiFullRuntimeProvider(BaseTextBackendRuntimeProvider):
    """Full-tier provider，基于 Gemini function calling 的工具循环。"""

    def __init__(
        self,
        *,
        project_root: Path,
        data_dir: Path,
        meta_store: SessionMetaStore,
        permission_gate: PermissionGate | None = None,
        max_tool_turns: int = MAX_TOOL_TURNS,
    ):
        super().__init__(
            provider_id=GEMINI_FULL_PROVIDER_ID,
            capabilities=AssistantProviderCapabilities(
                provider=GEMINI_FULL_PROVIDER_ID,
                tier="full",
                supports_streaming=True,
                supports_images=True,
                supports_tool_calls=True,
                supports_interrupt=True,
                supports_resume=True,
                supports_subagents=True,
                supports_permission_hooks=True,
            ),
            project_root=project_root,
            data_dir=data_dir,
            meta_store=meta_store,
        )
        self._permission_gate = permission_gate or get_default_gate()
        self._max_tool_turns = max_tool_turns
        self._project_manager = ProjectManager(projects_root=str(project_root / "projects"))
        self._tool_payload = _build_tool_payload()
        self._client_cache: tuple[tuple, Any, str] | None = None

    # ------------------------------------------------------------------
    # backend 选择（复用 lite 的 Gemini 配置解析）
    # ------------------------------------------------------------------

    async def _create_backend(self, project_name: str) -> Any:
        """Full provider 不通过 TextBackend.generate 简单出文本——
        我们直接持有 ``google-genai`` Client。这里仍 implement 是为了
        满足父类抽象接口，但实际不会调用此返回值；返回 None 占位。"""
        return None

    async def _get_genai_client(self) -> tuple[Any, str]:
        """从既有 config 系统拿 API key + 模型名，构造 ``google.genai.Client``。

        返回 ``(client, model_name)``，由 ``_run_generation`` 在每次会话用。
        Client 按配置 key 缓存；配置变化时自动重建。Vertex 模式的阻塞文件 I/O
        与凭证加载放到线程池执行。
        """
        from google import genai  # 延迟导入

        resolver = self._resolver
        async with resolver.session() as r:
            provider_id, model_id = await r.default_text_backend()
            aistudio = await r.provider_config("gemini-aistudio")

        api_key = (aistudio or {}).get("api_key")
        base_url = (aistudio or {}).get("base_url") or None
        model = model_id or "gemini-2.5-pro"
        cache_key = (provider_id, model_id, api_key, base_url)

        if self._client_cache is not None and self._client_cache[0] == cache_key:
            return self._client_cache[1], self._client_cache[2]

        if provider_id == "gemini-vertex":
            from google.oauth2 import service_account

            from lib.system_config import resolve_vertex_credentials_path

            cred_file = resolve_vertex_credentials_path(self._project_root)
            if cred_file is None:
                raise RuntimeError("未找到 Vertex AI 凭证；请将服务账号 JSON 放入 vertex_keys/")

            def _load_vertex_client():
                import json as _json

                with open(cred_file) as f:
                    proj_id = _json.load(f).get("project_id")
                creds = service_account.Credentials.from_service_account_file(
                    str(cred_file),
                    scopes=("https://www.googleapis.com/auth/cloud-platform",),
                )
                return genai.Client(vertexai=True, project=proj_id, location="global", credentials=creds)

            client = await asyncio.to_thread(_load_vertex_client)
        else:
            if not api_key:
                raise RuntimeError("Gemini AI Studio 未配置 API key；请在 /settings 设定")
            http_options = {"base_url": base_url} if base_url else None
            client = genai.Client(api_key=api_key, http_options=http_options)

        self._client_cache = (cache_key, client, model)
        return client, model

    # ------------------------------------------------------------------
    # send_new_session：override 前缀生成
    # ------------------------------------------------------------------

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
        managed = LiteManagedSession(
            session_id=session_id,
            project_name=project_name,
            persist_callback=self._persist_message,
        )
        self._sessions[session_id] = managed
        await self._start_generation(managed, prompt, echo_text=echo_text, echo_content=echo_content)
        return session_id

    # ------------------------------------------------------------------
    # 工具循环：override _run_generation
    # ------------------------------------------------------------------

    async def _run_generation(
        self,
        managed: LiteManagedSession,
        prompt: AssistantPrompt,
        *,
        echo_text: str | None,
        echo_content: list[dict[str, Any]] | None,
    ) -> None:
        try:
            client, model_name = await self._get_genai_client()
        except Exception as exc:
            logger.exception("gemini-full: client init failed")
            self._emit_error(managed, "config_error", str(exc))
            return

        prompt_text = self._extract_prompt_text(prompt, echo_text, echo_content)
        sandbox = ToolSandbox(
            project_root=self._project_root / "projects",
            project_name=managed.project_name,
        )
        skill_ctx = SkillCallContext(
            project_name=managed.project_name,
            sandbox=sandbox,
            project_manager=self._project_manager,
            session_id=managed.session_id,
        )

        # 历史 + 当前用户 prompt
        contents: list[dict[str, Any]] = await self._build_initial_contents(managed, prompt_text)

        try:
            for _turn in range(self._max_tool_turns):
                fcalls, text_chunks = await self._stream_one_turn(managed, client, model_name, contents)

                # 发出 assistant message（聚合文本）
                # streaming 模式下 text_chunks 是每个 chunk 一条，需合并为单一 text block
                full_text = "".join(text_chunks).strip()
                if full_text:
                    managed.add_message(
                        {
                            "type": "assistant",
                            "content": [{"type": "text", "text": full_text}],
                            "timestamp": _utc_now_iso(),
                            "uuid": uuid4().hex,
                            "provider": self.provider_id,
                            "model": model_name,
                        }
                    )
                # tool_use 各发一条独立消息（spec 要求；turn_grouper 按 tool_use_id 关联）
                for call in fcalls:
                    managed.add_message(
                        {
                            "type": "tool_use",
                            "tool_use_id": call["id"],
                            "name": call["name"],
                            "input": call["args"],
                            "timestamp": _utc_now_iso(),
                            "uuid": uuid4().hex,
                            "provider": self.provider_id,
                        }
                    )

                if not fcalls:
                    # 模型给出最终答复，结束
                    self._emit_success(managed, model_name)
                    return

                # 执行工具，构造 functionResponse
                tool_response_parts: list[dict[str, Any]] = []
                for call in fcalls:
                    response_payload = await self._execute_tool(managed, sandbox, skill_ctx, call)
                    tool_response_parts.append(
                        {
                            "function_response": {
                                "name": call["name"],
                                "response": response_payload,
                            }
                        }
                    )

                # 把模型这一轮的 functionCall 与本地 functionResponse 都拼回 contents。
                # Gemini 3 系列要求保留 thought_signature；缺失会触发 400。
                model_parts: list[dict[str, Any]] = []
                for c in fcalls:
                    fc_part: dict[str, Any] = {
                        "function_call": {"name": c["name"], "args": c["args"]},
                    }
                    if c.get("thought_signature") is not None:
                        fc_part["thought_signature"] = c["thought_signature"]
                    model_parts.append(fc_part)
                contents.append({"role": "model", "parts": model_parts})
                contents.append({"role": "user", "parts": tool_response_parts})

            # 超过最大轮数
            managed.add_message(
                {
                    "type": "result",
                    "subtype": "max_turns",
                    "is_error": True,
                    "timestamp": _utc_now_iso(),
                    "provider": self.provider_id,
                    "model": model_name,
                    "max_turns": self._max_tool_turns,
                }
            )
            managed.status = "error"
            await self._meta_store.update_status(managed.session_id, "error")
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
            logger.exception("gemini-full: generation failed session=%s", managed.session_id)
            self._emit_error(managed, "generation_failed", str(exc))
        finally:
            managed.generation_task = None

    # ------------------------------------------------------------------
    # 帮助函数
    # ------------------------------------------------------------------

    async def _build_initial_contents(self, managed: LiteManagedSession, prompt_text: str) -> list[dict[str, Any]]:
        """从 DB 历史 + 当前 prompt 构造 contents。

        简化版：仅把每条 ``user`` / ``assistant`` text 转成 Gemini ``parts``。
        重启恢复 session 时也能正确续接历史。
        """
        role_by_message_type = {
            "user": "user",
            "assistant": "model",
        }
        history = await self._load_history(managed.session_id)
        contents: list[dict[str, Any]] = []
        for msg in history:
            if not isinstance(msg, dict):
                continue
            role = role_by_message_type.get(str(msg.get("type")))
            if role is None:
                continue
            text = _extract_text(msg.get("content"))
            if text:
                contents.append({"role": role, "parts": [{"text": text}]})
            # tool_use / tool_result / result 暂不灌入 contents，避免污染上下文
            # （首期行为：重启后历史只保留对话流，工具调用记录在 DB 但不重放）

        if prompt_text:
            contents.append({"role": "user", "parts": [{"text": prompt_text}]})
        return contents

    async def _stream_one_turn(
        self,
        managed: LiteManagedSession,
        client: Any,
        model_name: str,
        contents: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], list[str]]:
        """流式跑一轮 generate，将文本 token 增量推送给订阅者；返回完整聚合结果。

        - 文本 chunk 通过 ``stream_event`` message 即时广播（前端能逐字显示）
        - functionCall 在流结束后一次性收集（function call 不会被分块）
        - 累计的文本块在流结束后作为 ``assistant`` message 写入 message_buffer / DB
        """
        text_buffer: list[str] = []
        fcalls: list[dict[str, Any]] = []
        draft_uuid = uuid4().hex

        try:
            stream = await self._gemini_stream(client, model_name, contents)
        except AttributeError:
            # Fake / 旧 SDK 不支持 stream：回退为单次 generate
            resp = await self._gemini_generate(client, model_name, contents)
            f, t = _split_response(resp)
            return f, t

        async for chunk in stream:
            chunk_calls, chunk_texts = _split_response(chunk)
            if chunk_texts:
                joined = "".join(chunk_texts)
                text_buffer.append(joined)
                # 流式 token 增量事件：前端 useAssistantSession 已实作 ``delta`` listener
                managed.add_message(
                    {
                        "type": "stream_event",
                        "uuid": draft_uuid,
                        "delta": {"type": "text_delta", "text": joined},
                        "timestamp": _utc_now_iso(),
                        "provider": self.provider_id,
                    }
                )
            if chunk_calls:
                fcalls.extend(chunk_calls)

        return fcalls, text_buffer

    async def _gemini_stream(self, client: Any, model_name: str, contents: list[dict[str, Any]]) -> Any:
        """获取 stream iterator。SDK 的方法是 ``generate_content_stream``，返回 async iterator。"""
        return await client.aio.models.generate_content_stream(
            model=model_name,
            contents=contents,
            config=self._gemini_config(),
        )

    async def _gemini_generate(self, client: Any, model_name: str, contents: list[dict[str, Any]]) -> Any:
        """单次 Gemini ``generate_content`` 调用，配置工具列表。"""
        return await client.aio.models.generate_content(
            model=model_name,
            contents=contents,
            config=self._gemini_config(),
        )

    def _gemini_config(self) -> dict[str, Any]:
        return {
            "tools": [{"function_declarations": self._tool_payload}],
            "system_instruction": self._build_system_prompt_full(),
        }

    def _build_system_prompt_full(self) -> str:
        return (
            "你是 ArcReel 的影片创作助理，运行在工作流模式下。"
            "你可以调用工具读写项目文件（fs_read/fs_write/fs_list）以及触发 skill"
            "（generate_script/generate_characters/generate_clues/manga_workflow_status 等）。"
            "请遵守：1) 在写入或大改前先 manga_workflow_status 检查阶段；"
            "2) 路径只能使用项目内相对路径；3) 工具失败时把错误反馈给用户而不是反复重试。"
        )

    async def _execute_tool(
        self,
        managed: LiteManagedSession,
        sandbox: ToolSandbox,
        skill_ctx: SkillCallContext,
        call: dict[str, Any],
    ) -> dict[str, Any]:
        """执行单个工具调用，写入 tool_result 消息后返回 functionResponse 内容。"""
        name = call["name"]
        args = call.get("args") or {}
        decision = self._permission_gate.check(name, args, managed.session_id)
        if isinstance(decision, Deny):
            payload = {"error": "permission_denied", "reason": decision.reason}
        elif isinstance(decision, AskUser):
            # 首期不实现交互审批，等同 Deny 但带提示
            payload = {
                "error": "permission_pending",
                "reason": "审批未实现；本次拒绝",
                "question": decision.question,
            }
        elif isinstance(decision, Allow):
            payload = await self._dispatch_tool(sandbox, skill_ctx, name, args)
        else:
            payload = {"error": "permission_unknown_decision"}

        # tool_result 消息：用同一个 id 关联 tool_use
        managed.add_message(
            {
                "type": "tool_result",
                "tool_use_id": call["id"],
                "content": payload,
                "is_error": "error" in payload,
                "timestamp": _utc_now_iso(),
                "uuid": uuid4().hex,
                "provider": self.provider_id,
            }
        )
        return payload

    async def _dispatch_tool(
        self,
        sandbox: ToolSandbox,
        skill_ctx: SkillCallContext,
        name: str,
        args: dict[str, Any],
    ) -> dict[str, Any]:
        """根据 name 派发到 fs_* 或 skill。"""
        try:
            if name == "fs_read":
                return fs_read(
                    sandbox,
                    str(args.get("path") or ""),
                    max_bytes=int(args.get("max_bytes") or 1024 * 1024),
                )
            if name == "fs_write":
                return fs_write(
                    sandbox,
                    str(args.get("path") or ""),
                    str(args.get("content") or ""),
                    mode=str(args.get("mode") or "overwrite"),
                )
            if name == "fs_list":
                return fs_list(sandbox, str(args.get("path") or ""))
            # 否则走 skill 注册表
            return await run_subagent(skill_ctx, name, args if isinstance(args, dict) else {})
        except Exception as exc:
            logger.exception("gemini-full: tool %s raised", name)
            return {"error": "tool_exception", "reason": str(exc)}

    def _emit_success(self, managed: LiteManagedSession, model_name: str) -> None:
        managed.add_message(
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "timestamp": _utc_now_iso(),
                "provider": self.provider_id,
                "model": model_name,
            }
        )
        managed.status = "completed"
        # update_status 是协程，但本函数被 _run_generation 的同步路径调用，
        # 这里用 create_task 防阻塞；否则会留 ``Coroutine never awaited`` warning
        loop = asyncio.get_event_loop()
        loop.create_task(self._meta_store.update_status(managed.session_id, "completed"))
        managed.add_message(self._build_runtime_status_message(managed.session_id, managed.status))

    def _emit_error(self, managed: LiteManagedSession, subtype: str, reason: str) -> None:
        managed.add_message(
            {
                "type": "result",
                "subtype": subtype,
                "is_error": True,
                "timestamp": _utc_now_iso(),
                "provider": self.provider_id,
                "error": reason,
            }
        )
        managed.status = "error"
        loop = asyncio.get_event_loop()
        loop.create_task(self._meta_store.update_status(managed.session_id, "error"))
        managed.add_message(self._build_runtime_status_message(managed.session_id, managed.status))


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def _extract_text(content: Any) -> str:
    """从 message.content（可能是 str / list[block]）提取纯文本。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "\n".join(parts)
    return ""


def _split_response(resp: Any) -> tuple[list[dict[str, Any]], list[str]]:
    """从 Gemini SDK 响应里抽出 ``functionCall`` 与文本块。

    ``resp.candidates[0].content.parts`` 中：
    - ``part.text`` 是文本
    - ``part.function_call`` 含 ``name`` 与 ``args``（``proto.MessageToDict``）
    """
    fcalls: list[dict[str, Any]] = []
    text_chunks: list[str] = []

    candidates = getattr(resp, "candidates", None) or []
    if not candidates:
        return fcalls, text_chunks

    parts = getattr(candidates[0].content, "parts", None) or []
    for part in parts:
        text = getattr(part, "text", None)
        if text:
            text_chunks.append(text)
            continue
        fc = getattr(part, "function_call", None)
        if fc is not None:
            args = getattr(fc, "args", None)
            # SDK 把 args 给成 MapComposite，转 dict
            try:
                args_dict = dict(args) if args else {}
            except Exception:
                args_dict = {}
            # Gemini 3 系列要求 functionCall 在下一轮回传时携带 thought_signature；
            # SDK 把它放在 part.thought_signature（bytes）。我们原样保留，喂回时透传。
            thought_signature = getattr(part, "thought_signature", None)
            fcalls.append(
                {
                    "id": uuid4().hex,
                    "thought_signature": thought_signature,
                    "name": getattr(fc, "name", ""),
                    "args": args_dict,
                }
            )
    return fcalls, text_chunks
