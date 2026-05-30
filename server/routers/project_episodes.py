"""
專案劇集路由

處理劇集的 CRUD、分集切分、合成與劇本生成。
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel, Field

from lib import PROJECT_ROOT, agent_profile
from lib.project_change_hints import project_change_source
from server.auth import CurrentUser


def get_project_manager():
    from server.routers.projects import get_project_manager as _get_pm

    return _get_pm()


def get_status_calculator():
    from server.routers.projects import get_status_calculator as _get_sc

    return _get_sc()


logger = logging.getLogger(__name__)

router = APIRouter()

_COMPOSE_ERROR_PREFIX = "❌ 錯誤:"
_COMPOSE_GENERIC_FAILURE_DETAIL = "合成成片失敗，請查看後端日誌。"
_MISSING_VIDEO_ERROR_FRAGMENTS = ("缺少影片片段", "影片檔案不存在", "沒有可用的影片片段")


class CreateEpisodeRequest(BaseModel):
    episode: int | None = None
    title: str | None = None


class UpdateEpisodeRequest(BaseModel):
    title: str | None = None


class ReorderEpisodesRequest(BaseModel):
    episodes: list[int]


class PeekSplitRequest(BaseModel):
    source: str
    target_chars: int
    context: int = 200


class SplitEpisodeRequest(BaseModel):
    source: str
    episode: int
    target_chars: int
    anchor: str
    context: int = 500
    title: str | None = None


class PreprocessRefs(BaseModel):
    overview: bool = True
    style: bool = True
    characters: list[str] | None = None
    clues: list[str] | None = None
    scenes: list[str] | None = None


class PreprocessEpisodeRequest(BaseModel):
    source: str | None = None
    refs: PreprocessRefs | None = None
    num_segments: int | None = Field(default=None, ge=1, le=100)


def _resolve_source_file_for_split(project_name: str, source: str) -> Path:
    from lib.episode_splitter import SourceFileError, resolve_source_under

    manager = get_project_manager()
    if not manager.project_exists(project_name):
        raise HTTPException(status_code=404, detail=f"專案 '{project_name}' 不存在")
    try:
        return resolve_source_under(manager.get_project_path(project_name), source)
    except SourceFileError as exc:
        raise HTTPException(status_code=422 if exc.kind == "path_escape" else 404, detail=str(exc)) from exc


def _find_episode_script_file(project: dict, episode: int) -> str | None:
    for ep in project.get("episodes", []):
        if int(ep.get("episode", -1)) == int(episode):
            sf = ep.get("script_file")
            if sf:
                return sf.replace("scripts/", "", 1) if sf.startswith("scripts/") else sf
    return None


def _compose_subprocess_env() -> dict[str, str]:
    env = os.environ.copy()
    existing_pythonpath = env.get("PYTHONPATH", "")
    if existing_pythonpath:
        env["PYTHONPATH"] = f"{PROJECT_ROOT}{os.pathsep}{existing_pythonpath}"
    else:
        env["PYTHONPATH"] = str(PROJECT_ROOT)
    return env


def _extract_compose_error(stdout: str, stderr: str) -> str:
    lines = [line.strip() for line in [*stdout.splitlines(), *stderr.splitlines()] if line.strip()]

    for line in reversed(lines):
        if _COMPOSE_ERROR_PREFIX in line:
            return line.split(_COMPOSE_ERROR_PREFIX, 1)[1].strip()

    for line in reversed(lines):
        if not line.startswith("Traceback "):
            return line[-500:]

    return ""


def _is_missing_video_compose_error(message: str) -> bool:
    return any(fragment in message for fragment in _MISSING_VIDEO_ERROR_FRAGMENTS)


def _compose_failure_detail(message: str) -> str:
    if not message or "ModuleNotFoundError" in message:
        return _COMPOSE_GENERIC_FAILURE_DETAIL
    return f"合成成片失敗：{message}"


def _append_empty_episode_item(name: str, episode: int, expected_mode: str, list_key: str, alt_route: str) -> dict:
    from lib.script_models import empty_drama_scene, empty_narration_segment

    manager = get_project_manager()
    if not manager.project_exists(name):
        raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
    content_mode = manager.load_project(name).get("content_mode", "narration")
    if content_mode != expected_mode:
        raise HTTPException(status_code=400, detail=f"此劇集是 {content_mode} 模式，請改用 {alt_route}")
    filename = f"episode_{episode}.json"
    try:
        script = manager.load_script(name, filename)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"劇集 E{episode} 的劇本不存在")
    items = script.setdefault(list_key, [])
    item_id = f"E{episode}S{len(items) + 1}"
    new_item = (
        empty_narration_segment(episode, item_id)
        if expected_mode == "narration"
        else empty_drama_scene(episode, item_id)
    )
    items.append(new_item)
    with project_change_source("webui"):
        manager.save_script(name, script, filename)
    singular = "segment" if list_key == "segments" else "scene"
    return {singular: new_item, f"{list_key}_count": len(items)}


@router.post("/projects/{name}/episodes")
async def create_episode(name: str, req: CreateEpisodeRequest, _user: CurrentUser):
    """新增劇集工作區，含一份空骨架劇本（segments/scenes 為空），不生成劇本內容。"""
    from lib.script_models import empty_drama_script, empty_narration_script

    try:

        def _sync():
            manager = get_project_manager()
            if not manager.project_exists(name):
                raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")

            project = manager.load_project(name)
            episodes = project.get("episodes", [])
            existing_numbers: list[int] = []
            for ep in episodes:
                try:
                    existing_numbers.append(int(ep.get("episode")))
                except (TypeError, ValueError):
                    continue

            episode_num = int(req.episode) if req.episode is not None else (max(existing_numbers, default=0) + 1)
            if episode_num < 1:
                raise HTTPException(status_code=400, detail="episode 必須大於 0")
            if episode_num in existing_numbers:
                raise HTTPException(status_code=400, detail=f"第 {episode_num} 集已存在")

            title = (req.title or "").strip() or f"第 {episode_num} 集"
            script_file = f"scripts/episode_{episode_num}.json"
            content_mode = project.get("content_mode", "narration")
            empty_script = (
                empty_drama_script(episode_num, title)
                if content_mode == "drama"
                else empty_narration_script(episode_num, title)
            )
            with project_change_source("webui"):
                project = manager.add_episode(name, episode_num, title, script_file)
                manager.save_script(name, empty_script, f"episode_{episode_num}.json")

            episode_entry = next(ep for ep in project.get("episodes", []) if int(ep.get("episode", -1)) == episode_num)
            return {"success": True, "episode": episode_entry, "project": project}

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/episodes/peek")
async def peek_episode_split(name: str, req: PeekSplitRequest, _user: CurrentUser):
    """預覽分集切分點（唯讀）。"""
    from lib import episode_splitter

    try:
        src_abs = _resolve_source_file_for_split(name, req.source)

        def _sync():
            text = src_abs.read_text(encoding="utf-8")
            return episode_splitter.peek_split(text, req.target_chars, req.context)

        return await asyncio.to_thread(_sync)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/episodes/split")
async def split_episode_route(name: str, req: SplitEpisodeRequest, _user: CurrentUser):
    """執行分集切分：寫 source/episode_{N}.txt + source/_remaining.txt，更新 project.json。"""
    from lib import episode_splitter

    try:
        manager = get_project_manager()
        src_abs = _resolve_source_file_for_split(name, req.source)

        def _sync():
            text = src_abs.read_text(encoding="utf-8")
            split = episode_splitter.split_episode_text(text, req.target_chars, req.anchor, req.context)
            manager.commit_episode_split(
                name,
                source_rel=req.source,
                episode=req.episode,
                part_before=split["part_before"],
                part_after=split["part_after"],
                title=req.title,
            )
            persisted = manager.load_project(name).get("episodes", [])
            if not any(int(ep.get("episode", -1)) == req.episode for ep in persisted):
                raise RuntimeError(f"episode {req.episode} 未出現在 project.json")
            return episode_splitter.split_result_dict(req.episode, split)

        with project_change_source("webui"):
            return await asyncio.to_thread(_sync)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/projects/{name}/episodes/order")
async def reorder_episodes(name: str, req: ReorderEpisodesRequest, _user: CurrentUser):
    """依傳入的集數順序重設每個劇集的 ``order`` 欄位（顯示順序）。"""
    try:

        def _sync():
            manager = get_project_manager()
            if not manager.project_exists(name):
                raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
            with project_change_source("webui"):
                project = manager.reorder_episodes(name, req.episodes)
            return {"success": True, "project": project}

        return await asyncio.to_thread(_sync)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/projects/{name}/episodes/{episode}")
async def update_episode(
    name: str,
    episode: int,
    req: UpdateEpisodeRequest,
    _user: CurrentUser,
):
    """更新劇集元資料（title 同步寫入 project.json 與 scripts/episode_N.json）。"""
    try:

        def _sync():
            manager = get_project_manager()
            project = manager.load_project(name)
            episodes = project.get("episodes", [])
            target = next((e for e in episodes if e.get("episode") == episode), None)
            if target is None:
                raise HTTPException(status_code=404, detail=f"劇集 E{episode} 不存在")

            new_title: str | None = None
            if req.title is not None:
                new_title = req.title.strip()
                if not new_title:
                    raise HTTPException(status_code=400, detail="title 不可為空")
                target["title"] = new_title

            with project_change_source("webui"):
                manager.save_project(name, project)
                if new_title is not None:
                    script_file = target.get("script_file") or f"scripts/episode_{episode}.json"
                    script_filename = script_file.replace("scripts/", "")
                    try:
                        script = manager.load_script(name, script_filename)
                        script["title"] = new_title
                        manager.save_script(name, script, script_filename)
                    except FileNotFoundError:
                        pass  # 劇本檔尚未生成時略過
            return {"success": True, "episode": target}

        return await asyncio.to_thread(_sync)
    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/projects/{name}/episodes/{episode}")
async def delete_episode(name: str, episode: int, _user: CurrentUser):
    """刪除一整集：移除劇本檔、預處理草稿、該集分鏡/影片/縮圖與版本檔、合成輸出。"""
    try:

        def _sync():
            manager = get_project_manager()
            if not manager.project_exists(name):
                raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
            with project_change_source("webui"):
                project, removed = manager.remove_episode(name, episode)
            return {"success": True, "episode": episode, "removed": removed, "project": project}

        return await asyncio.to_thread(_sync)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e).strip("'\""))
    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/episodes/{episode}/segments")
async def add_episode_segment(name: str, episode: int, _user: CurrentUser):
    """在指定劇集（說書模式）的劇本末尾新增一個空片段。"""
    try:
        return await asyncio.to_thread(_append_empty_episode_item, name, episode, "narration", "segments", "/scenes")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/episodes/{episode}/scenes")
async def add_episode_scene(name: str, episode: int, _user: CurrentUser):
    """在指定劇集（劇集動畫模式）的劇本末尾新增一個空場景。"""
    try:
        return await asyncio.to_thread(_append_empty_episode_item, name, episode, "drama", "scenes", "/segments")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/projects/{name}/episodes/{episode}/script")
async def reset_episode_script(name: str, episode: int, _user: CurrentUser):
    """清空指定劇集的劇本內容（重置為空骨架）。"""
    from lib.script_models import empty_drama_script, empty_narration_script

    def _sync():
        manager = get_project_manager()
        if not manager.project_exists(name):
            raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
        project = manager.load_project(name)
        ep_entry = next((e for e in project.get("episodes", []) if int(e.get("episode", -1)) == episode), None)
        if ep_entry is None:
            raise HTTPException(status_code=404, detail=f"劇集 E{episode} 不存在")
        filename = f"episode_{episode}.json"
        try:
            current = manager.load_script(name, filename)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail=f"劇集 E{episode} 的劇本不存在")
        content_mode = current.get("content_mode") or project.get("content_mode", "narration")
        title = current.get("title") or ep_entry.get("title") or f"第 {episode} 集"
        empty_script = (
            empty_drama_script(episode, title) if content_mode == "drama" else empty_narration_script(episode, title)
        )
        with project_change_source("webui"):
            manager.save_script(name, empty_script, filename)
        return {"success": True, "episode": episode, "content_mode": content_mode}

    try:
        return await asyncio.to_thread(_sync)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/episodes/{episode}/compose")
async def compose_episode_video(name: str, episode: int, _user: CurrentUser):
    """呼叫 compose-video skill 腳本拼接最終影片。"""
    try:
        manager = get_project_manager()

        def _prep():
            if not manager.project_exists(name):
                raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
            project = manager.load_project(name)
            script_file = _find_episode_script_file(project, episode)
            if not script_file:
                raise HTTPException(status_code=404, detail=f"第 {episode} 集不存在")
            project_path = manager.get_project_path(name)
            script_path = project_path / "scripts" / script_file
            if not script_path.exists():
                raise HTTPException(status_code=404, detail=f"劇本檔案不存在: {script_file}")
            return project_path, script_file

        project_path, script_file = await asyncio.to_thread(_prep)

        compose_script = agent_profile.skills_root(PROJECT_ROOT) / "compose-video" / "scripts" / "compose_video.py"
        if not compose_script.exists():
            raise HTTPException(status_code=500, detail=f"找不到 compose 腳本: {compose_script}")

        def _run():
            start = time.monotonic()
            proc = subprocess.run(
                [sys.executable, str(compose_script), script_file],
                cwd=str(project_path),
                capture_output=True,
                text=True,
                timeout=1800,
                env=_compose_subprocess_env(),
            )
            return proc, time.monotonic() - start

        proc, elapsed = await asyncio.to_thread(_run)
        if proc.returncode != 0:
            message = _extract_compose_error(proc.stdout, proc.stderr)
            logger.error(
                "compose_video failed rc=%s stdout=%s stderr=%s",
                proc.returncode,
                proc.stdout[-4000:],
                proc.stderr[-4000:],
            )
            if _is_missing_video_compose_error(message):
                detail = f"{message.rstrip('。')}，請先生成影片後再合成成片。"
                raise HTTPException(status_code=400, detail=detail)
            raise HTTPException(status_code=500, detail=_compose_failure_detail(message))

        output_path = ""
        for line in reversed(proc.stdout.splitlines()):
            if "最終影片" in line or "影片合成完成" in line:
                parts = line.split(":")
                if len(parts) >= 2:
                    output_path = parts[-1].strip()
                    break
        if not output_path:
            out_dir = project_path / "output"
            if out_dir.exists():
                mp4s = sorted(out_dir.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
                if mp4s:
                    output_path = str(mp4s[0].relative_to(project_path))

        return {
            "output_path": output_path,
            "stdout_tail": proc.stdout[-500:],
            "duration_seconds": round(elapsed, 2),
        }
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="compose_video 執行逾時（>30 分鐘）")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/episodes/{episode}/script")
async def generate_episode_script(name: str, episode: int, _user: CurrentUser):
    """生成指定集的 JSON 劇本，寫入 scripts/episode_{N}.json。"""
    from lib.script_generator import ScriptGenerator

    try:
        manager = get_project_manager()
        if not manager.project_exists(name):
            raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")

        project_path = manager.get_project_path(name)
        with project_change_source("webui"):
            generator = await ScriptGenerator.create(project_path)
            output_path = await generator.generate(episode=episode)

        def _sync_meta():
            project = manager.load_project(name)
            episodes = project.setdefault("episodes", [])
            script_file_rel = f"scripts/{output_path.name}"
            updated = False
            for ep in episodes:
                if int(ep.get("episode", -1)) == int(episode):
                    ep["script_file"] = script_file_rel
                    updated = True
                    break
            if not updated:
                episodes.append({"episode": int(episode), "script_file": script_file_rel})
            manager.save_project(name, project)
            try:
                script = manager.load_script(name, output_path.name)
            except FileNotFoundError:
                return 0
            return len(script.get("segments") or script.get("scenes") or [])

        with project_change_source("webui"):
            segments_count = await asyncio.to_thread(_sync_meta)

        return {
            "script_file": output_path.name,
            "segments_count": segments_count,
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/episodes/{episode}/preprocess")
async def preprocess_episode(
    name: str,
    episode: int,
    _user: CurrentUser,
    req: PreprocessEpisodeRequest = Body(default=None),
):
    """Step 1 預處理：根據 content_mode 呼叫對應 skill 腳本。"""
    from lib.episode_preprocess import SourceNotReadyError, run_preprocess

    try:
        manager = get_project_manager()
        if not manager.project_exists(name):
            raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")

        project = await asyncio.to_thread(manager.load_project, name)
        project_path = manager.get_project_path(name)
        source = req.source if req else None
        num_segments = req.num_segments if req else None
        refs_dict: dict | None = None
        if req and req.refs is not None:
            refs_dict = req.refs.model_dump(mode="json")
        with project_change_source("webui"):
            return await asyncio.to_thread(
                run_preprocess,
                project_path,
                episode,
                content_mode=project.get("content_mode", "narration"),
                repo_root=PROJECT_ROOT,
                source=source,
                refs=refs_dict,
                num_segments=num_segments,
            )

    except SourceNotReadyError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except (FileNotFoundError, RuntimeError) as e:
        raise HTTPException(status_code=500, detail=str(e))


def _delete_episode_item(name: str, item_id: str, script_file: str, list_key: str, id_key: str) -> dict:
    """從劇本中移除指定的片段／場景，回 {"success": True, "<list_key>_count": N}。"""
    manager = get_project_manager()
    if not manager.project_exists(name):
        raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
    try:
        script = manager.load_script(name, script_file)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="劇本不存在")
    items = script.get(list_key, [])
    new_items = [it for it in items if it.get(id_key) != item_id]
    if len(new_items) == len(items):
        raise HTTPException(status_code=404, detail=f"'{item_id}' 不存在")
    script[list_key] = new_items
    with project_change_source("webui"):
        manager.save_script(name, script, script_file)
    return {"success": True, f"{list_key}_count": len(new_items)}


@router.delete("/projects/{name}/segments/{segment_id}")
async def delete_segment(name: str, segment_id: str, script_file: Annotated[str, Query()], _user: CurrentUser):
    """刪除說書模式劇本中的一個片段。"""
    try:
        return await asyncio.to_thread(_delete_episode_item, name, segment_id, script_file, "segments", "segment_id")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/projects/{name}/scenes/{scene_id}")
async def delete_scene(name: str, scene_id: str, script_file: Annotated[str, Query()], _user: CurrentUser):
    """刪除劇集動畫模式劇本中的一個場景。"""
    try:
        return await asyncio.to_thread(_delete_episode_item, name, scene_id, script_file, "scenes", "scene_id")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))
