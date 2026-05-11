"""
專案管理路由

處理專案的 CRUD 操作，複用 lib/project_manager.py
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

if TYPE_CHECKING:
    from server.services.jianying_draft_service import JianyingDraftService

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi import Path as FastAPIPath
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

logger = logging.getLogger(__name__)

from lib import PROJECT_ROOT, agent_profile
from lib.asset_fingerprints import compute_asset_fingerprints
from lib.project_change_hints import project_change_source
from lib.project_manager import ProjectManager
from lib.status_calculator import StatusCalculator
from server.auth import CurrentUser, create_download_token, verify_download_token
from server.routers._validators import validate_backend_value
from server.services.project_archive import (
    ProjectArchiveService,
    ProjectArchiveValidationError,
)

router = APIRouter()

# 初始化專案管理器和狀態計算器
pm = ProjectManager(PROJECT_ROOT / "projects")
calc = StatusCalculator(pm)


def get_project_manager() -> ProjectManager:
    return pm


def get_status_calculator() -> StatusCalculator:
    return calc


def get_archive_service() -> ProjectArchiveService:
    return ProjectArchiveService(get_project_manager())


class CreateProjectRequest(BaseModel):
    name: str | None = None
    title: str | None = None
    style: str | None = ""
    content_mode: str | None = "narration"
    aspect_ratio: str | None = "9:16"
    default_duration: int | None = None


class UpdateProjectRequest(BaseModel):
    title: str | None = None
    style: str | None = None
    content_mode: str | None = None
    aspect_ratio: str | None = None
    default_duration: int | None = None
    video_backend: str | None = None
    image_backend: str | None = None
    video_generate_audio: bool | None = None
    text_backend_script: str | None = None
    text_backend_overview: str | None = None
    text_backend_style: str | None = None


def _cleanup_temp_file(path: str) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        return


def _cleanup_temp_dir(dir_path: str) -> None:
    shutil.rmtree(dir_path, ignore_errors=True)


@router.post("/projects/import")
async def import_project_archive(
    _user: CurrentUser,
    file: UploadFile = File(...),
    conflict_policy: str = Form("prompt"),
):
    """從 ZIP 匯入專案。"""
    upload_path: str | None = None
    try:
        fd, upload_path = tempfile.mkstemp(prefix="arcreel-upload-", suffix=".zip")
        os.close(fd)

        with open(upload_path, "wb") as target:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                target.write(chunk)

        def _sync():
            return get_archive_service().import_project_archive(
                Path(upload_path),
                uploaded_filename=file.filename,
                conflict_policy=conflict_policy,
            )

        result = await asyncio.to_thread(_sync)
        return {
            "success": True,
            "project_name": result.project_name,
            "project": result.project,
            "warnings": result.warnings,
            "conflict_resolution": result.conflict_resolution,
            "diagnostics": result.diagnostics,
        }
    except ProjectArchiveValidationError as exc:
        diagnostics = exc.extra.get(
            "diagnostics",
            {"blocking": [], "auto_fixable": [], "warnings": []},
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "detail": exc.detail,
                "errors": exc.errors,
                "warnings": exc.warnings,
                "diagnostics": diagnostics,
                **exc.extra,
            },
        )
    except Exception as e:
        logger.exception("請求處理失敗")
        return JSONResponse(
            status_code=500,
            content={"detail": str(e), "errors": [], "warnings": []},
        )
    finally:
        await file.close()
        if upload_path:
            _cleanup_temp_file(upload_path)


@router.post("/projects/{name}/export/token")
async def create_export_token(
    name: str,
    current_user: CurrentUser,
    scope: str = Query("full"),
):
    """簽發短時效下載 token，用於瀏覽器原生下載認證。"""
    try:
        if scope not in ("full", "current"):
            raise HTTPException(status_code=422, detail="scope 必須為 full 或 current")

        def _sync():
            if not get_project_manager().project_exists(name):
                raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在或未初始化")
            return get_archive_service().get_export_diagnostics(name, scope=scope)

        diagnostics = await asyncio.to_thread(_sync)
        username = current_user.sub
        download_token = create_download_token(username, name)
        return {
            "download_token": download_token,
            "expires_in": 300,
            "diagnostics": diagnostics,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{name}/export")
async def export_project_archive(
    name: str,
    download_token: str = Query(...),
    scope: str = Query("full"),
):
    """將專案匯出為 ZIP。需要 download_token 認證（透過 POST /export/token 獲取）。"""
    if scope not in ("full", "current"):
        raise HTTPException(status_code=422, detail="scope 必須為 full 或 current")

    # 驗證 download_token
    import jwt as pyjwt

    try:
        verify_download_token(download_token, name)
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="下載連結已過期，請重新匯出")
    except ValueError:
        raise HTTPException(status_code=403, detail="下載 token 與目標專案不匹配")
    except pyjwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="下載 token 無效")

    try:
        archive_path, download_name = await asyncio.to_thread(
            lambda: get_archive_service().export_project(name, scope=scope)
        )
        return FileResponse(
            archive_path,
            media_type="application/zip",
            filename=download_name,
            background=BackgroundTask(_cleanup_temp_file, str(archive_path)),
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在或未初始化")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


# --- 剪映草稿匯出 ---


def get_jianying_draft_service() -> JianyingDraftService:
    from server.services.jianying_draft_service import JianyingDraftService

    return JianyingDraftService(get_project_manager())


def _validate_draft_path(draft_path: str) -> str:
    """校驗 draft_path 合法性"""
    if not draft_path or not draft_path.strip():
        raise HTTPException(status_code=422, detail="請提供有效的剪映草稿目錄路徑")
    if len(draft_path) > 1024:
        raise HTTPException(status_code=422, detail="草稿目錄路徑過長")
    if any(ord(c) < 32 for c in draft_path):
        raise HTTPException(status_code=422, detail="草稿目錄路徑包含非法字元")
    return draft_path.strip()


@router.get("/projects/{name}/export/jianying-draft")
def export_jianying_draft(
    name: str,
    episode: int = Query(..., description="集數編號"),
    draft_path: str = Query(..., description="使用者本地剪映草稿目錄"),
    download_token: str = Query(..., description="下載 token"),
    jianying_version: str = Query("6", description="剪映版本：6 或 5"),
):
    """匯出指定集的剪映草稿 ZIP"""
    import jwt as pyjwt

    # 1. 驗證 download_token
    try:
        verify_download_token(download_token, name)
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="下載連結已過期，請重新匯出")
    except ValueError:
        raise HTTPException(status_code=403, detail="下載 token 與專案不匹配")
    except pyjwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="下載 token 無效")

    # 2. 校驗 draft_path
    draft_path = _validate_draft_path(draft_path)

    # 3. 呼叫服務
    svc = get_jianying_draft_service()
    try:
        zip_path = svc.export_episode_draft(
            project_name=name,
            episode=episode,
            draft_path=draft_path,
            use_draft_info_name=(jianying_version != "5"),
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception:
        logger.exception("剪映草稿匯出失敗: project=%s episode=%d", name, episode)
        raise HTTPException(status_code=500, detail="剪映草稿匯出失敗，請稍後重試")

    download_name = f"{name}_第{episode}集_剪映草稿.zip"

    return FileResponse(
        path=str(zip_path),
        media_type="application/zip",
        filename=download_name,
        background=BackgroundTask(_cleanup_temp_dir, str(zip_path.parent)),
    )


@router.get("/projects")
async def list_projects(_user: CurrentUser):
    """列出所有專案"""

    def _sync():
        manager = get_project_manager()
        calculator = get_status_calculator()
        projects = []
        for name in manager.list_projects():
            try:
                # 嘗試載入專案後設資料
                if manager.project_exists(name):
                    project = manager.load_project(name)
                    # 獲取縮圖（第一個分鏡圖）
                    project_dir = manager.get_project_path(name)
                    storyboards_dir = project_dir / "storyboards"
                    thumbnail = None
                    if storyboards_dir.exists():
                        scene_images = sorted(storyboards_dir.glob("scene_*.png"))
                        if scene_images:
                            thumbnail = f"/api/v1/files/{name}/storyboards/{scene_images[0].name}"

                    # 使用 StatusCalculator 計算進度（讀時計算）
                    status = calculator.calculate_project_status(name, project)

                    projects.append(
                        {
                            "name": name,
                            "title": project.get("title", name),
                            "style": project.get("style", ""),
                            "thumbnail": thumbnail,
                            "status": status,
                        }
                    )
                else:
                    # 沒有 project.json 的專案
                    projects.append(
                        {
                            "name": name,
                            "title": name,
                            "style": "",
                            "thumbnail": None,
                            "status": {},
                        }
                    )
            except Exception as e:
                # 出錯時返回基本資訊
                logger.warning("載入專案 '%s' 後設資料失敗: %s", name, e)
                projects.append(
                    {"name": name, "title": name, "style": "", "thumbnail": None, "status": {}, "error": str(e)}
                )

        return {"projects": projects}

    return await asyncio.to_thread(_sync)


@router.post("/projects")
async def create_project(req: CreateProjectRequest, _user: CurrentUser):
    """建立新專案"""
    try:

        def _sync():
            manager = get_project_manager()
            title = (req.title or "").strip()
            manual_name = (req.name or "").strip()
            if not title and not manual_name:
                raise HTTPException(status_code=400, detail="專案標題不能為空")
            project_name = manual_name or manager.generate_project_name(title)

            try:
                manager.create_project(project_name)
            except FileExistsError:
                raise HTTPException(status_code=400, detail=f"專案 '{project_name}' 已存在")
            with project_change_source("webui"):
                project = manager.create_project_metadata(
                    project_name,
                    title or manual_name,
                    req.style,
                    req.content_mode,
                    aspect_ratio=req.aspect_ratio,
                    default_duration=req.default_duration,
                )
            return {"success": True, "name": project_name, "project": project}

        return await asyncio.to_thread(_sync)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{name}")
async def get_project(name: str, _user: CurrentUser):
    """獲取專案詳情（含實時計算欄位）"""
    try:

        def _sync():
            manager = get_project_manager()
            calculator = get_status_calculator()
            if not manager.project_exists(name):
                raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在或未初始化")

            project = manager.load_project(name)

            # 注入計算欄位（不寫入 JSON，僅用於 API 響應）
            project = calculator.enrich_project(name, project)

            # 載入所有劇本並注入計算欄位
            scripts = {}
            for ep in project.get("episodes", []):
                script_file = ep.get("script_file", "")
                if script_file:
                    try:
                        script = manager.load_script(name, script_file)
                        script = calculator.enrich_script(script)
                        key = (
                            script_file.replace("scripts/", "", 1)
                            if script_file.startswith("scripts/")
                            else script_file
                        )
                        scripts[key] = script
                    except FileNotFoundError:
                        logger.debug("劇本檔案不存在，跳過: %s/%s", name, script_file)

            # 計算媒體檔案指紋（用於前端內容定址快取）
            project_path = manager.get_project_path(name)
            fingerprints = compute_asset_fingerprints(project_path)

            return {
                "project": project,
                "scripts": scripts,
                "asset_fingerprints": fingerprints,
            }

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/projects/{name}")
async def update_project(name: str, req: UpdateProjectRequest, _user: CurrentUser):
    """更新專案後設資料"""
    try:

        def _sync():
            manager = get_project_manager()
            project = manager.load_project(name)

            if req.content_mode is not None:
                raise HTTPException(
                    status_code=400,
                    detail="專案建立後不支援修改 content_mode",
                )

            if req.title is not None:
                project["title"] = req.title
            if req.style is not None:
                project["style"] = req.style
            for field in (
                "video_backend",
                "image_backend",
                "text_backend_script",
                "text_backend_overview",
                "text_backend_style",
            ):
                if field in req.model_fields_set:
                    value = getattr(req, field)
                    if value:
                        validate_backend_value(value, field)
                        project[field] = value
                    else:
                        project.pop(field, None)
            if "video_generate_audio" in req.model_fields_set:
                if req.video_generate_audio is None:
                    project.pop("video_generate_audio", None)
                else:
                    project["video_generate_audio"] = req.video_generate_audio
            if "aspect_ratio" in req.model_fields_set and req.aspect_ratio is not None:
                project["aspect_ratio"] = req.aspect_ratio
            if "default_duration" in req.model_fields_set:
                if req.default_duration is None:
                    project.pop("default_duration", None)
                else:
                    project["default_duration"] = req.default_duration

            with project_change_source("webui"):
                manager.save_project(name, project)
            return {"success": True, "project": project}

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/projects/{name}")
async def delete_project(name: str, _user: CurrentUser):
    """刪除專案"""
    try:

        def _sync():
            project_dir = get_project_manager().get_project_path(name)
            shutil.rmtree(project_dir)
            return {"success": True, "message": f"專案 '{name}' 已刪除"}

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{name}/scripts/{script_file}")
async def get_script(name: str, script_file: str, _user: CurrentUser):
    """獲取劇本內容"""
    try:
        script = await asyncio.to_thread(get_project_manager().load_script, name, script_file)
        return {"script": script}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"劇本 '{script_file}' 不存在")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


class UpdateSceneRequest(BaseModel):
    script_file: str
    updates: dict


@router.patch("/projects/{name}/scenes/{scene_id}")
async def update_scene(name: str, scene_id: str, req: UpdateSceneRequest, _user: CurrentUser):
    """更新場景"""
    try:

        def _sync():
            manager = get_project_manager()
            script = manager.load_script(name, req.script_file)

            # 找到並更新場景
            scene_found = False
            for scene in script.get("scenes", []):
                if scene.get("scene_id") == scene_id:
                    scene_found = True
                    # 更新允許的欄位
                    for key, value in req.updates.items():
                        if key in [
                            "duration_seconds",
                            "image_prompt",
                            "video_prompt",
                            "characters_in_scene",
                            "clues_in_scene",
                            "segment_break",
                            "note",
                        ]:
                            if value is None and key != "note":
                                continue
                            scene[key] = value
                    break

            if not scene_found:
                raise HTTPException(status_code=404, detail=f"場景 '{scene_id}' 不存在")

            with project_change_source("webui"):
                manager.save_script(name, script, req.script_file)
            return {"success": True, "scene": scene}

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="劇本不存在")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


class UpdateSegmentRequest(BaseModel):
    script_file: str
    duration_seconds: int | None = None
    segment_break: bool | None = None
    image_prompt: dict | str | None = None
    video_prompt: dict | str | None = None
    transition_to_next: str | None = None
    note: str | None = None
    novel_text: str | None = None


class UpdateOverviewRequest(BaseModel):
    synopsis: str | None = None
    genre: str | None = None
    theme: str | None = None
    world_setting: str | None = None


@router.patch("/projects/{name}/segments/{segment_id}")
async def update_segment(name: str, segment_id: str, req: UpdateSegmentRequest, _user: CurrentUser):
    """更新說書模式片段"""
    try:

        def _sync():
            manager = get_project_manager()
            script = manager.load_script(name, req.script_file)

            # 檢查是否為說書模式
            if script.get("content_mode") != "narration" and "segments" not in script:
                raise HTTPException(status_code=400, detail="該劇本不是說書模式，請使用場景更新介面")

            # 找到並更新片段
            segment_found = False
            for segment in script.get("segments", []):
                if segment.get("segment_id") == segment_id:
                    segment_found = True
                    if req.duration_seconds is not None:
                        segment["duration_seconds"] = req.duration_seconds
                    if req.segment_break is not None:
                        segment["segment_break"] = req.segment_break
                    if req.image_prompt is not None:
                        segment["image_prompt"] = req.image_prompt
                    if req.video_prompt is not None:
                        segment["video_prompt"] = req.video_prompt
                    if req.transition_to_next is not None:
                        segment["transition_to_next"] = req.transition_to_next
                    if "note" in req.model_fields_set:
                        segment["note"] = req.note
                    if req.novel_text is not None:
                        segment["novel_text"] = req.novel_text
                    break

            if not segment_found:
                raise HTTPException(status_code=404, detail=f"片段 '{segment_id}' 不存在")

            with project_change_source("webui"):
                manager.save_script(name, script, req.script_file)
            return {"success": True, "segment": segment}

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="劇本不存在")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 劇集元資料 ====================


class UpdateEpisodeRequest(BaseModel):
    title: str | None = None


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


# ==================== 原始檔管理 ====================


@router.post("/projects/{name}/source")
async def set_project_source(
    name: Annotated[str, FastAPIPath(pattern=r"^[a-zA-Z0-9_-]+$")],
    _user: CurrentUser,
    generate_overview: Annotated[bool, Form()] = True,
    content: Annotated[str | None, Form()] = None,
    file: Annotated[UploadFile | None, File()] = None,
):
    """上傳小說原始檔或直接提交文字內容，可選觸發 AI 概述生成。

    兩種輸入方式（互斥，均使用 multipart/form-data）：
    - file：上傳 .txt/.md 檔案，檔名取自上傳檔案
    - content：直接提交文字內容，自動命名為 novel.txt

    最大 200000 字元（約 10 萬漢字）。
    """
    MAX_CHARS = 200_000
    ALLOWED_SUFFIXES = {".txt", ".md"}

    if not content and not file:
        raise HTTPException(status_code=400, detail="需要提供 content（文字內容）或 file（檔案上傳）其中之一")
    if content and file:
        raise HTTPException(status_code=400, detail="content 和 file 不能同時提供，請選擇其一")

    try:
        manager = get_project_manager()

        # 非同步讀取上傳檔案
        raw: bytes | None = None
        if file:
            original_name = file.filename or "novel.txt"
            suffix = Path(original_name).suffix.lower()
            if suffix not in ALLOWED_SUFFIXES:
                raise HTTPException(status_code=400, detail=f"僅支援 .txt / .md 檔案，收到: {original_name!r}")
            if file.size is not None and file.size > MAX_CHARS * 4:
                raise HTTPException(status_code=400, detail=f"檔案大小超出限制（最大約 {MAX_CHARS} 字元）")
            raw = await file.read()

        # 同步檔案 I/O 線上程中執行
        def _sync_write():
            if not manager.project_exists(name):
                raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
            project_dir = manager.get_project_path(name)
            source_dir = project_dir / "source"
            source_dir.mkdir(parents=True, exist_ok=True)

            if raw is not None:
                safe_filename = Path(original_name).name
                try:
                    text = raw.decode("utf-8")
                except UnicodeDecodeError:
                    raise HTTPException(status_code=400, detail="檔案編碼錯誤，請使用 UTF-8 編碼的文字檔案")
                if len(text) > MAX_CHARS:
                    raise HTTPException(
                        status_code=400, detail=f"檔案內容超出最大限制 {MAX_CHARS} 字元（當前 {len(text)}）"
                    )
                (source_dir / safe_filename).write_text(text, encoding="utf-8")
                return safe_filename, len(text)
            else:
                if len(content) > MAX_CHARS:
                    raise HTTPException(
                        status_code=400, detail=f"content 超出最大長度 {MAX_CHARS} 字元（當前 {len(content)}）"
                    )
                safe_filename = "novel.txt"
                (source_dir / safe_filename).write_text(content, encoding="utf-8")
                return safe_filename, len(content)

        safe_filename, chars = await asyncio.to_thread(_sync_write)

        result: dict = {"success": True, "filename": safe_filename, "chars": chars}

        if generate_overview:
            try:
                with project_change_source("webui"):
                    overview = await manager.generate_overview(name)
                result["overview"] = overview
            except Exception as ov_err:
                result["overview"] = None
                result["overview_error"] = str(ov_err)

        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if file:
            await file.close()


# ==================== 專案概述管理 ====================


@router.post("/projects/{name}/generate-overview")
async def generate_overview(name: str, _user: CurrentUser):
    """使用 AI 生成專案概述"""
    try:
        with project_change_source("webui"):
            overview = await get_project_manager().generate_overview(name)
        return {"success": True, "overview": overview}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 劇集流程：合成 / 劇本生成 / 預處理 ====================


def _find_episode_script_file(project: dict, episode: int) -> str | None:
    """從 project.json 找到指定集對應的 script_file（相對路徑，不含 scripts/ 前綴）。"""
    for ep in project.get("episodes", []):
        if int(ep.get("episode", -1)) == int(episode):
            sf = ep.get("script_file")
            if sf:
                return sf.replace("scripts/", "", 1) if sf.startswith("scripts/") else sf
    return None


@router.post("/projects/{name}/episodes/{episode}/compose")
async def compose_episode_video(name: str, episode: int, _user: CurrentUser):
    """呼叫 compose-video skill 腳本拼接最終影片。阻塞執行，最長 30 分鐘。"""
    import subprocess
    import sys
    import time

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

        compose_script = (
            agent_profile.skills_root(PROJECT_ROOT)
            / "compose-video"
            / "scripts"
            / "compose_video.py"
        )
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
            )
            return proc, time.monotonic() - start

        proc, elapsed = await asyncio.to_thread(_run)
        if proc.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"compose_video 執行失敗 (rc={proc.returncode}): {proc.stderr[-2000:]}",
            )

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
async def preprocess_episode(name: str, episode: int, _user: CurrentUser):
    """Step 1 預處理：根據 content_mode 呼叫對應 skill 腳本。"""
    import subprocess
    import sys

    try:
        manager = get_project_manager()
        if not manager.project_exists(name):
            raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")

        project = await asyncio.to_thread(manager.load_project, name)
        content_mode = project.get("content_mode", "narration")

        if content_mode == "narration":
            script_filename = "split_narration_segments.py"
            output_filename = "step1_segments.md"
        elif content_mode == "drama":
            script_filename = "normalize_drama_script.py"
            output_filename = "step1_normalized_script.md"
        else:
            raise HTTPException(status_code=400, detail=f"未知的 content_mode: {content_mode}")

        project_path = manager.get_project_path(name)
        skill_script = (
            agent_profile.skills_root(PROJECT_ROOT)
            / "generate-script"
            / "scripts"
            / script_filename
        )
        if not skill_script.exists():
            raise HTTPException(status_code=500, detail=f"找不到預處理腳本: {skill_script}")

        def _run():
            return subprocess.run(
                [sys.executable, str(skill_script), "--episode", str(episode)],
                cwd=str(project_path),
                capture_output=True,
                text=True,
                timeout=1800,
            )

        proc = await asyncio.to_thread(_run)
        if proc.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"{script_filename} 失敗 (rc={proc.returncode}): {proc.stderr[-2000:]}",
            )

        step1_path = project_path / "drafts" / f"episode_{episode}" / output_filename
        rel = f"drafts/episode_{episode}/{output_filename}" if step1_path.exists() else ""
        return {"step1_path": rel, "content_mode": content_mode}

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="預處理執行逾時（>30 分鐘）")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/projects/{name}/overview")
async def update_overview(name: str, req: UpdateOverviewRequest, _user: CurrentUser):
    """更新專案概述（手動編輯）"""
    try:

        def _sync():
            manager = get_project_manager()
            project = manager.load_project(name)

            if "overview" not in project:
                project["overview"] = {}

            if req.synopsis is not None:
                project["overview"]["synopsis"] = req.synopsis
            if req.genre is not None:
                project["overview"]["genre"] = req.genre
            if req.theme is not None:
                project["overview"]["theme"] = req.theme
            if req.world_setting is not None:
                project["overview"]["world_setting"] = req.world_setting

            with project_change_source("webui"):
                manager.save_project(name, project)
            return {"success": True, "overview": project["overview"]}

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"專案 '{name}' 不存在")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))
