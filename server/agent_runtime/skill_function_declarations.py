"""把 ArcReel 的 workflow skill 翻译成 Gemini ``FunctionDeclaration``。

每条 skill 由两部分组成：
- 一个 ``FunctionDeclaration``，描述参数 schema（喂给 ``google-genai`` 的 ``Tool``）。
- 一个 async handler ``Callable[[SkillCallContext], Awaitable[dict]]``，
  实现真正的副作用（调用既有的 ``ProjectManager`` / generation queue / script generator）。

handler 拿到的是结构化参数 + 当前 session 的 ``SkillCallContext``，绝不再二次解析 LLM 输出。
所有路径相关参数都会走 ``ToolSandbox`` 校验，越界拒绝。

Workflow skills 全部接入：
- ``peek_split_point``       ✅ 預覽分集切分點
- ``split_episode``          ✅ 執行分集切分並更新 project.json
- ``preprocess_episode``     ✅ Step 1 拆段/規範化
- ``generate_script``         ✅ 调用 ScriptGenerator 生成 episode 剧本
- ``generate_characters``     ✅ 写入 project.json 角色定义
- ``generate_clues``          ✅ 写入 project.json 线索定义
- ``manga_workflow_status``   ✅ 编排状态查询，纯只读
- ``generate_storyboard``     ✅ 批量入队 storyboard task，等待 worker 完成
- ``generate_video``          ✅ 批量入队 video task，等待 worker 完成
- ``compose_video``           ✅ subprocess 调用 compose_video.py（ffmpeg）

handler 注册表 ``SKILL_HANDLERS`` 是单一真相源，``run_subagent`` 工具按 name 派发。
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from lib import agent_profile
from lib.project_manager import ProjectManager
from server.agent_runtime.tool_sandbox import ToolSandbox

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 调用上下文
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SkillCallContext:
    """传给 skill handler 的 per-call 上下文。

    Attributes:
        project_name: 当前 session 绑定的项目名。
        sandbox: 已绑定该 project 的沙盒实例。
        project_manager: 共享的 ProjectManager（避免 handler 自行实例化）。
        session_id: 当前 assistant session id（用于审计 / 关联日志）。
        user_id: 调用方 user id（沿用既有 generation_queue 的 user_id 语义）。
    """

    project_name: str
    sandbox: ToolSandbox
    project_manager: ProjectManager
    session_id: str
    user_id: str = "default"


SkillHandler = Callable[[SkillCallContext, dict[str, Any]], Awaitable[dict[str, Any]]]


def _invalid_episode_error() -> dict[str, str]:
    return {"error": "invalid_argument", "reason": "episode must be a positive integer"}


def _get_positive_episode(args: dict[str, Any]) -> int | None:
    episode = args.get("episode")
    if isinstance(episode, int) and episode >= 1:
        return episode
    return None


def _build_persist_failure(
    *,
    entity_label: str,
    persisted: dict[str, Any],
    added: list[str],
    skipped: list[dict[str, str]],
) -> dict[str, Any] | None:
    not_persisted = [name for name in added if name not in persisted]
    if not not_persisted:
        return None
    return {
        "ok": False,
        "error": "persist_failed",
        "reason": f"{entity_label}寫入後未出現在 project.json：{not_persisted}",
        "added": [name for name in added if name in persisted],
        "skipped": skipped,
    }


def _safe_project_file_exists(project_path: Path, rel_path: Any) -> bool:
    if not isinstance(rel_path, str) or not rel_path.strip():
        return False
    try:
        base = project_path.resolve()
        full_path = (project_path / rel_path).resolve()
        return full_path.is_relative_to(base) and full_path.exists()
    except (OSError, ValueError):
        return False


def _resolve_source_file(ctx: SkillCallContext, source: str) -> tuple[Path | None, dict[str, Any] | None]:
    from lib.episode_splitter import SourceFileError, resolve_source_under

    if not source:
        return None, {"ok": False, "error": "invalid_argument", "reason": "需要 source(str)"}
    try:
        src_abs = resolve_source_under(ctx.project_manager.get_project_path(ctx.project_name), source)
    except SourceFileError as exc:
        return None, {"ok": False, "error": exc.kind, "reason": str(exc)}
    return src_abs, None


def _missing_script_assets(
    project_path: Path,
    script_data: dict[str, Any],
    *,
    asset_key: str,
    output_dir: str,
    suffix: str,
) -> list[str]:
    try:
        from lib.storyboard_sequence import get_storyboard_items
    except Exception:
        logger.warning("failed to import storyboard sequence helper", exc_info=True)
        return []

    items, id_field, _, _ = get_storyboard_items(script_data)
    missing: list[str] = []
    for item in items:
        resource_id = str(item.get(id_field) or "").strip()
        if not resource_id:
            continue
        assets = item.get("generated_assets") if isinstance(item.get("generated_assets"), dict) else {}
        configured_path = assets.get(asset_key)
        fallback_path = f"{output_dir}/scene_{resource_id}.{suffix}"
        if not (
            _safe_project_file_exists(project_path, configured_path)
            or _safe_project_file_exists(project_path, fallback_path)
        ):
            missing.append(resource_id)
    return missing


# ---------------------------------------------------------------------------
# FunctionDeclaration 数据结构（不依赖 google-genai SDK，便于单测与未来切换）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FunctionDeclaration:
    """与 ``google.generativeai.protos.FunctionDeclaration`` 同形的本地表示。

    字段名与 OpenAPI / JSON Schema 对齐，便于后续直接 ``model_dump`` 喂给 Gemini SDK。
    """

    name: str
    description: str
    parameters: dict[str, Any]

    def to_gemini(self) -> dict[str, Any]:
        """转换为 Gemini SDK 接受的 plain dict 形式。"""
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }


# ---------------------------------------------------------------------------
# Skill: peek_split_point / split_episode / preprocess_episode
# ---------------------------------------------------------------------------

PEEK_SPLIT_POINT_DECL = FunctionDeclaration(
    name="peek_split_point",
    description=(
        "預覽分集切分點（唯讀）。給定 source/ 下的小說檔與目標字數，回該位置前後文與附近自然斷點，"
        "供你決定要在哪個句末/段落切。切完一集後可對 source/_remaining.txt 再 peek 下一集。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "source": {
                "type": "string",
                "description": "source/ 下的相對路徑，如 source/novel.txt 或 source/_remaining.txt",
            },
            "target_chars": {
                "type": "integer",
                "description": "目標有效字數（含標點不含空行）",
            },
            "context": {
                "type": "integer",
                "description": "前後文與斷點搜尋視窗，預設 200",
            },
        },
        "required": ["source", "target_chars"],
    },
)


async def _handle_peek_split_point(ctx: SkillCallContext, args: dict[str, Any]) -> dict[str, Any]:
    from lib import episode_splitter

    source = str(args.get("source") or "").strip()
    target_chars = args.get("target_chars")
    context = args.get("context") or 200
    if not isinstance(target_chars, int):
        return {"ok": False, "error": "invalid_argument", "reason": "需要 target_chars(int)"}
    src_abs, error = _resolve_source_file(ctx, source)
    if error is not None:
        return error

    try:
        text = src_abs.read_text(encoding="utf-8")
        return episode_splitter.peek_split(text, target_chars, context)
    except ValueError as exc:
        return {"ok": False, "error": "invalid_argument", "reason": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": "peek_failed", "reason": str(exc)}


SPLIT_EPISODE_DECL = FunctionDeclaration(
    name="split_episode",
    description=(
        "執行分集切分：用目標字數縮小範圍、用 anchor（切點前 10~20 字的原文片段）精確定位，"
        "把 source/<檔> 切成 source/episode_{N}.txt（前半）與 source/_remaining.txt（後半），"
        "並在 project.json 加 episodes 條目。原始檔不會被修改。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "source": {"type": "string", "description": "source/ 下的相對路徑"},
            "episode": {"type": "integer", "description": "集數編號（1, 2, ...）"},
            "target_chars": {"type": "integer", "description": "與 peek 用的目標字數一致"},
            "anchor": {"type": "string", "description": "切點前的原文片段（10~20 字），用來精確定位切點"},
            "context": {"type": "integer", "description": "anchor 搜尋視窗，預設 500"},
            "title": {"type": "string", "description": "（可選）這一集的標題"},
        },
        "required": ["source", "episode", "target_chars", "anchor"],
    },
)


async def _handle_split_episode(ctx: SkillCallContext, args: dict[str, Any]) -> dict[str, Any]:
    from lib import episode_splitter

    source = str(args.get("source") or "").strip()
    episode = args.get("episode")
    target_chars = args.get("target_chars")
    anchor = str(args.get("anchor") or "")
    context = args.get("context") or 500
    title = args.get("title")
    if not isinstance(episode, int) or episode < 1 or not isinstance(target_chars, int) or not anchor:
        return {
            "ok": False,
            "error": "invalid_argument",
            "reason": "需要 episode(int>=1), target_chars(int), anchor(str)",
        }
    src_abs, error = _resolve_source_file(ctx, source)
    if error is not None:
        return error

    try:
        text = src_abs.read_text(encoding="utf-8")
        split = episode_splitter.split_episode_text(text, target_chars, anchor, context)
    except Exception as exc:
        return {"ok": False, "error": "split_failed", "reason": str(exc)}

    try:
        ctx.project_manager.commit_episode_split(
            ctx.project_name,
            source_rel=source,
            episode=episode,
            part_before=split["part_before"],
            part_after=split["part_after"],
            title=title if isinstance(title, str) else None,
        )
    except Exception as exc:
        return {"ok": False, "error": "persist_failed", "reason": str(exc)}

    persisted = ctx.project_manager.load_project(ctx.project_name).get("episodes", [])
    if not any(int(ep.get("episode", -1)) == episode for ep in persisted):
        return {"ok": False, "error": "persist_failed", "reason": f"episode {episode} 未出現在 project.json"}

    return {"ok": True, **episode_splitter.split_result_dict(episode, split)}


PREPROCESS_EPISODE_DECL = FunctionDeclaration(
    name="preprocess_episode",
    description=(
        "對某一集做 Step 1 預處理（依 content_mode：narration→拆段 / drama→規範化劇本），"
        "產出 drafts/episode_{N}/step1_*.md。生成 JSON 劇本（generate_script）前必須先做這步。"
    ),
    parameters={
        "type": "object",
        "properties": {"episode": {"type": "integer", "description": "集數編號"}},
        "required": ["episode"],
    },
)


async def _handle_preprocess_episode(ctx: SkillCallContext, args: dict[str, Any]) -> dict[str, Any]:
    from lib.episode_preprocess import run_preprocess

    episode = args.get("episode")
    if not isinstance(episode, int) or episode < 1:
        return {"ok": False, "error": "invalid_argument", "reason": "需要 episode(int>=1)"}
    project_path = ctx.project_manager.get_project_path(ctx.project_name)
    try:
        result = await asyncio.to_thread(
            run_preprocess,
            project_path,
            episode,
            repo_root=ctx.project_manager.projects_root.parent,
        )
        return {"ok": True, **result}
    except ValueError as exc:
        return {"ok": False, "error": "invalid_content_mode", "reason": str(exc)}
    except FileNotFoundError as exc:
        return {"ok": False, "error": "script_missing", "reason": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": "preprocess_failed", "reason": str(exc)}


# ---------------------------------------------------------------------------
# Skill: generate_script
# ---------------------------------------------------------------------------

GENERATE_SCRIPT_DECL = FunctionDeclaration(
    name="generate_script",
    description=(
        "为指定剧集生成 JSON 剧本，写入 scripts/episode_{N}.json。"
        "前置条件：projects/{name}/drafts/episode_{N}/ 必须已含 step1 中间文件，"
        "且 project.json 已有 characters / clues / overview / style。"
        "异步任务，handler 内部会调用 ScriptGenerator.generate() 并阻塞等待。"
        "返回写入路径与片段统计。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "episode": {
                "type": "integer",
                "description": "剧集编号（>=1）",
            },
            "output_path": {
                "type": "string",
                "description": "可选；自定义输出相对路径（默认 scripts/episode_{N}.json）",
            },
        },
        "required": ["episode"],
    },
)


async def _handle_generate_script(ctx: SkillCallContext, args: dict[str, Any]) -> dict[str, Any]:
    from lib.script_generator import ScriptGenerator  # 延迟导入，避免循环

    episode = _get_positive_episode(args)
    if episode is None:
        return _invalid_episode_error()

    output_rel = args.get("output_path")
    output_path: Path | None = None
    if output_rel:
        try:
            output_path = ctx.sandbox.validate_path(str(output_rel))
        except Exception as exc:
            return {"error": "sandbox_violation", "reason": str(exc)}

    project_path = ctx.project_manager.get_project_path(ctx.project_name)
    try:
        generator = await ScriptGenerator.create(project_path)
        written = await generator.generate(episode, output_path=output_path)
    except FileNotFoundError as exc:
        return {"error": "missing_prerequisite", "reason": str(exc)}
    except Exception as exc:
        logger.exception("generate_script failed for %s ep%s", ctx.project_name, episode)
        return {"error": "generation_failed", "reason": str(exc)}

    # 读回统计信息
    try:
        data = json.loads(Path(written).read_text(encoding="utf-8"))
        scenes = len(data.get("scenes") or data.get("segments") or [])
    except Exception:
        scenes = 0

    return {
        "ok": True,
        "script_file": str(written.relative_to(project_path)),
        "episode": episode,
        "scenes_count": scenes,
    }


# ---------------------------------------------------------------------------
# Skill: generate_characters
# ---------------------------------------------------------------------------

GENERATE_CHARACTERS_DECL = FunctionDeclaration(
    name="generate_characters",
    description=(
        "向 project.json 新增或更新一组角色定义（不立即生成图片，仅写入文本元数据）。"
        "图片生成由 generation queue 异步处理，handler 仅同步写入定义并入队。"
        "若需要立即等待图片产出，请使用前端的「生成」按钮或 generation_tasks API。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "characters": {
                "type": "array",
                "description": "角色列表",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "description": {
                            "type": "string",
                            "description": "敘事式描述：年龄、体态、面部特征、服饰、气质",
                        },
                        "voice_style": {"type": "string"},
                    },
                    "required": ["name", "description"],
                },
            }
        },
        "required": ["characters"],
    },
)


async def _handle_generate_characters(ctx: SkillCallContext, args: dict[str, Any]) -> dict[str, Any]:
    chars = args.get("characters")
    if not isinstance(chars, list) or not chars:
        return {"error": "invalid_argument", "reason": "characters must be a non-empty array"}

    added: list[str] = []
    skipped: list[dict[str, str]] = []
    for entry in chars:
        if not isinstance(entry, dict):
            skipped.append({"name": "<invalid>", "reason": "entry must be object"})
            continue
        name = str(entry.get("name") or "").strip()
        description = str(entry.get("description") or "").strip()
        if not name or not description:
            skipped.append({"name": name or "<empty>", "reason": "name and description required"})
            continue
        voice_style = entry.get("voice_style") or ""
        try:
            ctx.project_manager.add_project_character(
                ctx.project_name,
                name=name,
                description=description,
                voice_style=voice_style,
            )
            added.append(name)
        except Exception as exc:
            skipped.append({"name": name, "reason": str(exc)})

    persisted = ctx.project_manager.load_project(ctx.project_name).get("characters", {})
    persist_failure = _build_persist_failure(
        entity_label="角色",
        persisted=persisted,
        added=added,
        skipped=skipped,
    )
    if persist_failure:
        return persist_failure
    if not added:
        return {
            "ok": False,
            "error": "nothing_added",
            "reason": "沒有任何角色被寫入（全部 skipped）",
            "skipped": skipped,
        }
    return {"ok": True, "added": added, "skipped": skipped}


# ---------------------------------------------------------------------------
# Skill: generate_clues
# ---------------------------------------------------------------------------

GENERATE_CLUES_DECL = FunctionDeclaration(
    name="generate_clues",
    description=(
        "向 project.json 新增或更新一组线索（道具/地点）定义。"
        "与 generate_characters 类似：仅写入定义，图片生成由 queue 异步处理。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "clues": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "clue_type": {
                            "type": "string",
                            "enum": ["prop", "location"],
                        },
                        "description": {"type": "string"},
                        "importance": {
                            "type": "string",
                            "enum": ["major", "minor"],
                            "description": "默认 minor；major 会触发后续 clue_sheet 图片生成",
                        },
                    },
                    "required": ["name", "clue_type", "description"],
                },
            }
        },
        "required": ["clues"],
    },
)


async def _handle_generate_clues(ctx: SkillCallContext, args: dict[str, Any]) -> dict[str, Any]:
    clues = args.get("clues")
    if not isinstance(clues, list) or not clues:
        return {"error": "invalid_argument", "reason": "clues must be a non-empty array"}

    added: list[str] = []
    skipped: list[dict[str, str]] = []
    for entry in clues:
        if not isinstance(entry, dict):
            skipped.append({"name": "<invalid>", "reason": "entry must be object"})
            continue
        name = str(entry.get("name") or "").strip()
        clue_type = entry.get("clue_type")
        description = str(entry.get("description") or "").strip()
        importance = entry.get("importance") or "minor"
        if not name or clue_type not in {"prop", "location"} or not description:
            skipped.append({"name": name or "<empty>", "reason": "missing or invalid fields"})
            continue
        try:
            created = ctx.project_manager.add_clue(
                ctx.project_name,
                name=name,
                clue_type=clue_type,
                description=description,
                importance=importance,
            )
            if created:
                added.append(name)
            else:
                skipped.append({"name": name, "reason": "already exists"})
        except Exception as exc:
            skipped.append({"name": name, "reason": str(exc)})

    persisted = ctx.project_manager.load_project(ctx.project_name).get("clues", {})
    persist_failure = _build_persist_failure(
        entity_label="線索",
        persisted=persisted,
        added=added,
        skipped=skipped,
    )
    if persist_failure:
        return persist_failure
    return {"ok": True, "added": added, "skipped": skipped}


# ---------------------------------------------------------------------------
# Skill: manga_workflow_status (只读编排状态)
# ---------------------------------------------------------------------------

MANGA_WORKFLOW_STATUS_DECL = FunctionDeclaration(
    name="manga_workflow_status",
    description=(
        "检查当前项目的工作流状态，返回下一阶段建议。"
        "纯只读：读取 project.json + 文件系统状态，按规则匹配阶段（1-8）。"
        "建议在每次决策前先调用此工具，避免重复执行已完成阶段。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "episode": {
                "type": "integer",
                "description": "可选；指定要检查的剧集编号。若省略则返回最新未完成集。",
            }
        },
    },
)


async def _handle_manga_workflow_status(ctx: SkillCallContext, args: dict[str, Any]) -> dict[str, Any]:
    episode = args.get("episode")
    try:
        project = ctx.project_manager.load_project(ctx.project_name)
    except FileNotFoundError:
        return {"error": "project_not_found", "reason": ctx.project_name}

    characters = project.get("characters") or {}
    clues = project.get("clues") or {}
    episodes = project.get("episodes") or []
    project_path = ctx.project_manager.get_project_path(ctx.project_name)

    # 阶段 1：角色/线索为空
    if not characters and not clues:
        return {
            "stage": 1,
            "stage_name": "全局角色/线索设计",
            "next_action": "调用 generate_characters / generate_clues 写入定义",
            "context": {
                "characters_count": 0,
                "clues_count": 0,
            },
        }

    # 选目标集
    target_ep: int | None = None
    if isinstance(episode, int) and episode >= 1:
        target_ep = episode
    else:
        # 找最新未完成集；若 episodes 为空，默认 1
        if not episodes:
            target_ep = 1
        else:
            target_ep = max((e.get("episode", 0) for e in episodes), default=1)

    ep_dir = project_path / "drafts" / f"episode_{target_ep}"
    script_file = project_path / "scripts" / f"episode_{target_ep}.json"
    source_file = project_path / "source" / f"episode_{target_ep}.txt"

    if not source_file.exists():
        return {
            "stage": 2,
            "stage_name": "源文件缺失",
            "next_action": f"请将 episode {target_ep} 的小说原文放入 source/episode_{target_ep}.txt",
            "context": {"episode": target_ep},
        }

    content_mode = project.get("content_mode") or "narration"
    expected_step1 = ep_dir / ("step1_segments.md" if content_mode == "narration" else "step1_normalized_script.md")
    if not expected_step1.exists():
        return {
            "stage": 3,
            "stage_name": "Step 1 预处理未完成",
            "next_action": (
                f"dispatch {'split-narration-segments' if content_mode == 'narration' else 'normalize-drama-script'} subagent"
            ),
            "context": {"episode": target_ep, "content_mode": content_mode},
        }

    if not script_file.exists():
        return {
            "stage": 4,
            "stage_name": "JSON 剧本生成",
            "next_action": f"调用 generate_script(episode={target_ep})",
            "context": {"episode": target_ep},
        }

    # 阶段 5/6：检查角色 / 主要线索的 sheet
    missing_char_sheets = [n for n, c in characters.items() if not (c or {}).get("character_sheet")]
    missing_clue_sheets = [
        n for n, c in clues.items() if (c or {}).get("importance") == "major" and not (c or {}).get("clue_sheet")
    ]
    if missing_char_sheets or missing_clue_sheets:
        return {
            "stage": "5_6",
            "stage_name": "角色/主要线索图片生成",
            "next_action": "通过前端「生成」按钮或 generation queue 触发",
            "context": {
                "missing_character_sheets": missing_char_sheets,
                "missing_clue_sheets": missing_clue_sheets,
            },
        }

    try:
        script_data = json.loads(script_file.read_text(encoding="utf-8"))
    except Exception as exc:
        return {
            "stage": 4,
            "stage_name": "JSON 剧本不可读",
            "next_action": f"修复 scripts/episode_{target_ep}.json 后再继续",
            "context": {"episode": target_ep, "reason": str(exc)},
        }

    # 阶段 7/8：分镜 / 视频。当前资产路径为扁平结构：
    # storyboards/scene_E1S1.png、videos/scene_E1S1.mp4。
    missing_storyboards = _missing_script_assets(
        project_path,
        script_data,
        asset_key="storyboard_image",
        output_dir="storyboards",
        suffix="png",
    )
    missing_videos = _missing_script_assets(
        project_path,
        script_data,
        asset_key="video_clip",
        output_dir="videos",
        suffix="mp4",
    )

    if missing_storyboards:
        return {
            "stage": 7,
            "stage_name": "分镜图生成",
            "next_action": f"调用 generate_storyboard(episode={target_ep})",
            "context": {"episode": target_ep, "missing_storyboards": missing_storyboards},
        }
    if missing_videos:
        return {
            "stage": 8,
            "stage_name": "视频生成",
            "next_action": f"调用 generate_video(episode={target_ep})",
            "context": {"episode": target_ep, "missing_videos": missing_videos},
        }

    return {
        "stage": "complete",
        "stage_name": "工作流完成",
        "next_action": "可在 Web 端导出剪映草稿或合成成片",
        "context": {"episode": target_ep},
    }


# ---------------------------------------------------------------------------
# Skill: generate_storyboard
# ---------------------------------------------------------------------------

GENERATE_STORYBOARD_DECL = FunctionDeclaration(
    name="generate_storyboard",
    description=(
        "为指定剧集的所有场景批量生成分镜图（image-to-image），写入 storyboards/scene_*.png。"
        "前置：scripts/episode_{N}.json 已生成。每个场景使用劇本內預先寫好的 image_prompt。"
        "异步走 generation queue，handler 阻塞等所有 task 完成。"
        "可选 scene_ids 只生成部分场景。返回成功/失败统计。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "episode": {"type": "integer", "description": "剧集编号（>=1）"},
            "scene_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "可选；只生成指定 segment_id / scene_id；省略则生成全部",
            },
        },
        "required": ["episode"],
    },
)


async def _handle_generate_storyboard(ctx: SkillCallContext, args: dict[str, Any]) -> dict[str, Any]:
    return await _enqueue_episode_assets(ctx, args, task_type="storyboard", media_type="image")


# ---------------------------------------------------------------------------
# Skill: generate_video
# ---------------------------------------------------------------------------

GENERATE_VIDEO_DECL = FunctionDeclaration(
    name="generate_video",
    description=(
        "为指定剧集的所有场景批量生成动态影片片段（image-to-video，每段 5-10 秒），"
        "写入 videos/scene_*.mp4。前置：分镜图已生成（storyboards/scene_*.png）。"
        "异步走 generation queue，handler 阻塞等待完成。"
        "可选 scene_ids 只生成部分场景。返回成功/失败统计。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "episode": {"type": "integer"},
            "scene_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "可选；只生成指定场景；省略则生成全部",
            },
        },
        "required": ["episode"],
    },
)


async def _handle_generate_video(ctx: SkillCallContext, args: dict[str, Any]) -> dict[str, Any]:
    return await _enqueue_episode_assets(ctx, args, task_type="video", media_type="video")


# ---------------------------------------------------------------------------
# Skill: compose_video
# ---------------------------------------------------------------------------

COMPOSE_VIDEO_DECL = FunctionDeclaration(
    name="compose_video",
    description=(
        "把指定剧集的所有 scene 视频片段用 ffmpeg 拼接为完整成片，写入 output/episode_{N}_final.mp4。"
        "前置：videos/scene_*.mp4 已就绪。可选 music 路径加 BGM。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "episode": {"type": "integer"},
            "music": {
                "type": "string",
                "description": "可选；BGM 文件相对路径（如 source/bgm.mp3）",
            },
            "music_volume": {
                "type": "number",
                "description": "BGM 音量 0.0-1.0，默认 0.3",
            },
        },
        "required": ["episode"],
    },
)


async def _handle_compose_video(ctx: SkillCallContext, args: dict[str, Any]) -> dict[str, Any]:
    import asyncio
    import subprocess

    episode = _get_positive_episode(args)
    if episode is None:
        return _invalid_episode_error()

    project_path = ctx.project_manager.get_project_path(ctx.project_name)
    script_file = f"episode_{episode}.json"
    script_path = project_path / "scripts" / script_file
    if not script_path.exists():
        return {"error": "missing_prerequisite", "reason": f"scripts/{script_file} 不存在"}
    try:
        script_data = json.loads(script_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"error": "invalid_script", "reason": str(exc)}
    missing_videos = _missing_script_assets(
        project_path,
        script_data,
        asset_key="video_clip",
        output_dir="videos",
        suffix="mp4",
    )
    if missing_videos:
        return {
            "error": "missing_prerequisite",
            "reason": "合成前需要先有影片片段",
            "missing_videos": missing_videos,
            "next_action": "询问使用者是否要生成缺失影片；不要在 compose_video 请求中自动调用 generate_video",
        }

    script_module = (
        agent_profile.skills_root(Path(__file__).resolve().parents[2])
        / "compose-video"
        / "scripts"
        / "compose_video.py"
    )
    if not script_module.exists():
        return {"error": "compose_script_missing", "reason": str(script_module)}

    output_filename = f"episode_{episode}_final.mp4"
    output_rel = f"output/{output_filename}"
    cmd: list[str] = [
        sys.executable,
        str(script_module),
        str(script_path),
        "--output",
        output_filename,
    ]
    music = args.get("music")
    if music:
        try:
            music_abs = ctx.sandbox.validate_path(str(music))
        except Exception as exc:
            return {"error": "sandbox_violation", "reason": str(exc)}
        cmd.extend(["--music", str(music_abs)])
        if (vol := args.get("music_volume")) is not None:
            cmd.extend(["--music-volume", str(vol)])

    # 子進程 cwd 切到 project_path 後，sys.path 不再包含 repo root，
    # compose_video.py 的 `from lib.project_manager import ...` 會 ModuleNotFoundError。
    # 注入 PYTHONPATH 指向 repo root，並保留既有 PYTHONPATH。
    import os as _os

    repo_root = Path(__file__).resolve().parents[2]
    sub_env = _os.environ.copy()
    existing_pp = sub_env.get("PYTHONPATH", "")
    sub_env["PYTHONPATH"] = f"{repo_root}{_os.pathsep}{existing_pp}" if existing_pp else str(repo_root)

    def _run() -> tuple[int, str, str]:
        proc = subprocess.run(
            cmd,
            cwd=project_path,
            capture_output=True,
            text=True,
            timeout=900,
            env=sub_env,
        )
        return proc.returncode, proc.stdout[-2000:], proc.stderr[-2000:]

    try:
        rc, out, err = await asyncio.to_thread(_run)
    except subprocess.TimeoutExpired:
        return {"error": "compose_timeout", "reason": "ffmpeg compose timed out (15min)"}
    except FileNotFoundError as exc:
        return {"error": "compose_not_runnable", "reason": str(exc)}

    if rc != 0:
        return {"error": "compose_failed", "rc": rc, "stderr": err.strip()[-500:]}

    return {
        "ok": True,
        "output": output_rel,
        "stdout_tail": out.strip()[-500:],
    }


# ---------------------------------------------------------------------------
# 共用：批量入队某集所有 scene/segment 资产
# ---------------------------------------------------------------------------


async def _enqueue_episode_assets(
    ctx: SkillCallContext,
    args: dict[str, Any],
    *,
    task_type: str,
    media_type: str,
) -> dict[str, Any]:
    """通用 batch-enqueue：generate_storyboard / generate_video 共用。

    读取 scripts/episode_{N}.json，遍历 scene/segment，把每个 item 的 image_prompt 或
    video_prompt 入队为 task_type=storyboard / video，等待全部完成。
    """
    from lib.generation_queue_client import BatchTaskSpec, _batch_enqueue_and_wait

    episode = _get_positive_episode(args)
    if episode is None:
        return _invalid_episode_error()

    project_path = ctx.project_manager.get_project_path(ctx.project_name)
    script_file = f"episode_{episode}.json"
    script_path = project_path / "scripts" / script_file
    if not script_path.exists():
        return {
            "error": "missing_prerequisite",
            "reason": f"scripts/{script_file} 不存在；请先调用 generate_script(episode={episode})",
        }

    try:
        script_data = json.loads(script_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"error": "invalid_script", "reason": str(exc)}

    # 复用既有 storyboard_sequence helper
    try:
        from lib.storyboard_sequence import get_storyboard_items
    except Exception as exc:
        return {"error": "import_failed", "reason": str(exc)}

    items, id_field, _, _ = get_storyboard_items(script_data)
    if not items:
        return {"error": "empty_script", "reason": "script contains no scenes/segments"}

    requested_ids = args.get("scene_ids")
    if isinstance(requested_ids, list) and requested_ids:
        wanted = {str(i) for i in requested_ids}
        items = [it for it in items if str(it.get(id_field)) in wanted]
        if not items:
            return {"error": "no_match", "reason": "scene_ids not found in script"}

    prompt_field = "image_prompt" if task_type == "storyboard" else "video_prompt"
    specs: list[BatchTaskSpec] = []
    skipped: list[dict[str, str]] = []
    for it in items:
        rid = str(it.get(id_field) or "")
        prompt = it.get(prompt_field)
        if not rid or prompt is None:
            skipped.append({"resource_id": rid or "<empty>", "reason": f"missing {prompt_field}"})
            continue
        specs.append(
            BatchTaskSpec(
                task_type=task_type,
                media_type=media_type,
                resource_id=rid,
                payload={
                    "prompt": prompt,
                    "script_file": script_file,
                },
                script_file=script_file,
                source="agent",
            )
        )

    if not specs:
        return {"error": "nothing_to_enqueue", "skipped": skipped}

    try:
        successes, failures = await _batch_enqueue_and_wait(
            ctx.project_name,
            specs,
            None,
            None,
        )
    except Exception as exc:
        logger.exception("%s batch enqueue failed for %s ep%s", task_type, ctx.project_name, episode)
        return {"error": "queue_failure", "reason": str(exc)}

    return {
        "ok": True,
        "task_type": task_type,
        "episode": episode,
        "succeeded": [s.resource_id for s in successes],
        "failed": [{"resource_id": f.resource_id, "error": f.error} for f in failures],
        "skipped": skipped,
    }


# ---------------------------------------------------------------------------
# 注册表
# ---------------------------------------------------------------------------


SKILL_DECLARATIONS: list[FunctionDeclaration] = [
    PEEK_SPLIT_POINT_DECL,
    SPLIT_EPISODE_DECL,
    PREPROCESS_EPISODE_DECL,
    GENERATE_SCRIPT_DECL,
    GENERATE_CHARACTERS_DECL,
    GENERATE_CLUES_DECL,
    MANGA_WORKFLOW_STATUS_DECL,
    GENERATE_STORYBOARD_DECL,
    GENERATE_VIDEO_DECL,
    COMPOSE_VIDEO_DECL,
]


SKILL_HANDLERS: dict[str, SkillHandler] = {
    "peek_split_point": _handle_peek_split_point,
    "split_episode": _handle_split_episode,
    "preprocess_episode": _handle_preprocess_episode,
    "generate_script": _handle_generate_script,
    "generate_characters": _handle_generate_characters,
    "generate_clues": _handle_generate_clues,
    "manga_workflow_status": _handle_manga_workflow_status,
    "generate_storyboard": _handle_generate_storyboard,
    "generate_video": _handle_generate_video,
    "compose_video": _handle_compose_video,
}


def get_skill_names() -> list[str]:
    return list(SKILL_HANDLERS.keys())


async def run_subagent(
    ctx: SkillCallContext,
    skill: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    """同步阻塞 dispatch 一个 skill。

    供 ``run_subagent`` 工具直接调用；也可被 provider 内部直接走 declarations 路径调用。
    """
    handler = SKILL_HANDLERS.get(skill)
    if handler is None:
        return {
            "error": "unknown_skill",
            "available": get_skill_names(),
        }
    if not isinstance(args, dict):
        return {"error": "invalid_argument", "reason": "args must be an object"}
    try:
        return await handler(ctx, args)
    except Exception as exc:
        logger.exception("skill %s raised", skill)
        return {"error": "skill_exception", "reason": str(exc)}
