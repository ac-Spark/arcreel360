"""
生成 API 路由

處理分鏡圖、影片、角色圖、線索圖的生成請求。
所有生成請求入隊到 GenerationQueue，由 GenerationWorker 非同步執行。
"""

import asyncio
import logging

logger = logging.getLogger(__name__)

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from lib import PROJECT_ROOT
from lib.generation_queue import get_generation_queue
from lib.project_manager import ProjectManager
from lib.prompt_utils import (
    is_structured_image_prompt,
    is_structured_video_prompt,
)
from lib.storyboard_sequence import (
    find_storyboard_item,
    get_storyboard_items,
)
from server.auth import CurrentUser

router = APIRouter()

# 初始化管理器
pm = ProjectManager(PROJECT_ROOT / "projects")


def get_project_manager() -> ProjectManager:
    return pm


# ==================== 請求模型 ====================


class GenerateStoryboardRequest(BaseModel):
    prompt: str | dict
    script_file: str


class GenerateVideoRequest(BaseModel):
    prompt: str | dict
    script_file: str
    duration_seconds: int | None = None  # 改為 None，由服務層解析
    seed: int | None = None


class GenerateCharacterRequest(BaseModel):
    prompt: str


class GenerateClueRequest(BaseModel):
    prompt: str


_LEGACY_PROVIDER_NAMES: dict[str, str] = {
    "gemini": "gemini-aistudio",
    "aistudio": "gemini-aistudio",
    "vertex": "gemini-vertex",
}


def _normalize_provider_id(raw: str) -> str:
    """將舊格式 provider 名稱歸一化為標準 provider_id。"""
    return _LEGACY_PROVIDER_NAMES.get(raw, raw)


def _snapshot_image_backend(project_name: str) -> dict:
    """快照圖片供應商配置，返回可合併到 payload 的字典。

    優先順序：專案級 image_backend > 系統級 default_image_backend。
    """
    project = get_project_manager().load_project(project_name)
    project_image_backend = project.get("image_backend")  # 格式: "provider_id/model"
    if project_image_backend and "/" in project_image_backend:
        image_provider, image_model = project_image_backend.split("/", 1)
    elif project_image_backend:
        image_provider = _normalize_provider_id(project_image_backend)
        image_model = ""
    else:
        return {}  # 無專案級覆蓋，使用全域性預設
    return {
        "image_provider": image_provider,
        "image_model": image_model,
    }


# ==================== 分鏡圖生成 ====================


@router.post("/projects/{project_name}/generate/storyboard/{segment_id}")
async def generate_storyboard(
    project_name: str,
    segment_id: str,
    req: GenerateStoryboardRequest,
    _user: CurrentUser,
):
    """
    提交分鏡圖生成任務到佇列，立即返回 task_id。

    生成由 GenerationWorker 非同步執行，狀態透過 SSE 推送。
    """
    try:

        def _sync():
            get_project_manager().load_project(project_name)
            script = get_project_manager().load_script(project_name, req.script_file)
            items, id_field, _, _ = get_storyboard_items(script)
            resolved = find_storyboard_item(items, id_field, segment_id)
            if resolved is None:
                raise HTTPException(status_code=404, detail=f"片段/場景 '{segment_id}' 不存在")
            return _snapshot_image_backend(project_name)

        image_snapshot = await asyncio.to_thread(_sync)

        # 驗證 prompt 格式
        if isinstance(req.prompt, dict):
            if not is_structured_image_prompt(req.prompt):
                raise HTTPException(
                    status_code=400,
                    detail="prompt 必須是字串或包含 scene/composition 的物件",
                )
            scene_text = str(req.prompt.get("scene", "")).strip()
            if not scene_text:
                raise HTTPException(status_code=400, detail="prompt.scene 不能為空")
        elif not isinstance(req.prompt, str):
            raise HTTPException(status_code=400, detail="prompt 必須是字串或物件")

        # 入隊
        queue = get_generation_queue()
        result = await queue.enqueue_task(
            project_name=project_name,
            task_type="storyboard",
            media_type="image",
            resource_id=segment_id,
            script_file=req.script_file,
            payload={
                "prompt": req.prompt,
                "script_file": req.script_file,
                **image_snapshot,
            },
            source="webui",
            user_id=_user.id,
        )

        return {
            "success": True,
            "task_id": result["task_id"],
            "message": f"分鏡「{segment_id}」生成任務已提交",
        }

    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 影片生成 ====================


@router.post("/projects/{project_name}/generate/video/{segment_id}")
async def generate_video(project_name: str, segment_id: str, req: GenerateVideoRequest, _user: CurrentUser):
    """
    提交影片生成任務到佇列，立即返回 task_id。

    需要先有分鏡圖作為起始幀。生成由 GenerationWorker 非同步執行。
    """
    try:

        def _sync():
            get_project_manager().load_project(project_name)
            project_path = get_project_manager().get_project_path(project_name)
            storyboard_file = project_path / "storyboards" / f"scene_{segment_id}.png"
            if not storyboard_file.exists():
                raise HTTPException(status_code=400, detail=f"請先生成分鏡圖 scene_{segment_id}.png")

        await asyncio.to_thread(_sync)

        # 驗證 prompt 格式
        if isinstance(req.prompt, dict):
            if not is_structured_video_prompt(req.prompt):
                raise HTTPException(
                    status_code=400,
                    detail="prompt 必須是字串或包含 action/camera_motion 的物件",
                )
            action_text = str(req.prompt.get("action", "")).strip()
            if not action_text:
                raise HTTPException(status_code=400, detail="prompt.action 不能為空")
            dialogue = req.prompt.get("dialogue", [])
            if dialogue is not None and not isinstance(dialogue, list):
                raise HTTPException(status_code=400, detail="prompt.dialogue 必須是陣列")
        elif not isinstance(req.prompt, str):
            raise HTTPException(status_code=400, detail="prompt 必須是字串或物件")

        # 入隊（provider 由服務層根據配置自動解析，呼叫方無需傳遞）
        queue = get_generation_queue()
        result = await queue.enqueue_task(
            project_name=project_name,
            task_type="video",
            media_type="video",
            resource_id=segment_id,
            script_file=req.script_file,
            payload={
                "prompt": req.prompt,
                "script_file": req.script_file,
                "duration_seconds": req.duration_seconds,
                "seed": req.seed,
            },
            source="webui",
            user_id=_user.id,
        )

        return {
            "success": True,
            "task_id": result["task_id"],
            "message": f"影片「{segment_id}」生成任務已提交",
        }

    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 角色設計圖生成 ====================


@router.post("/projects/{project_name}/generate/character/{char_name}")
async def generate_character(
    project_name: str,
    char_name: str,
    req: GenerateCharacterRequest,
    _user: CurrentUser,
):
    """
    提交角色設計圖生成任務到佇列，立即回傳 task_id。
    """
    try:

        def _sync():
            project = get_project_manager().load_project(project_name)
            if char_name not in project.get("characters", {}):
                raise HTTPException(status_code=404, detail=f"角色「{char_name}」不存在")
            return _snapshot_image_backend(project_name)

        image_snapshot = await asyncio.to_thread(_sync)

        # 入隊
        queue = get_generation_queue()
        result = await queue.enqueue_task(
            project_name=project_name,
            task_type="character",
            media_type="image",
            resource_id=char_name,
            payload={
                "prompt": req.prompt,
                **image_snapshot,
            },
            source="webui",
            user_id=_user.id,
        )

        return {
            "success": True,
            "task_id": result["task_id"],
            "message": f"角色「{char_name}」設計圖生成任務已提交",
        }

    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 線索設計圖生成 ====================


@router.post("/projects/{project_name}/generate/clue/{clue_name}")
async def generate_clue(project_name: str, clue_name: str, req: GenerateClueRequest, _user: CurrentUser):
    """
    提交道具設計圖生成任務到佇列，立即回傳 task_id。
    """
    try:

        def _sync():
            project = get_project_manager().load_project(project_name)
            if clue_name not in project.get("clues", {}):
                raise HTTPException(status_code=404, detail=f"道具「{clue_name}」不存在")
            return _snapshot_image_backend(project_name)

        image_snapshot = await asyncio.to_thread(_sync)

        # 入隊
        queue = get_generation_queue()
        result = await queue.enqueue_task(
            project_name=project_name,
            task_type="clue",
            media_type="image",
            resource_id=clue_name,
            payload={
                "prompt": req.prompt,
                **image_snapshot,
            },
            source="webui",
            user_id=_user.id,
        )

        return {
            "success": True,
            "task_id": result["task_id"],
            "message": f"道具「{clue_name}」設計圖生成任務已提交",
        }

    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("請求處理失敗")
        raise HTTPException(status_code=500, detail=str(e))
