"""費用估算 API 路由。"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException

from lib import PROJECT_ROOT
from lib.config.resolver import ConfigResolver
from lib.db import async_session_factory
from lib.project_manager import ProjectManager
from lib.usage_tracker import UsageTracker
from server.auth import CurrentUser
from server.services.cost_estimation import CostEstimationService

router = APIRouter()
logger = logging.getLogger(__name__)
pm = ProjectManager(PROJECT_ROOT / "projects")


@router.get("/projects/{project_name}/cost-estimate")
async def get_cost_estimate(project_name: str, _user: CurrentUser):
    """獲取專案費用估算（預估 + 實際）。"""

    def _sync():
        if not pm.project_exists(project_name):
            raise HTTPException(status_code=404, detail=f"專案 '{project_name}' 不存在")

        try:
            project_data = pm.load_project(project_name)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail=f"專案 '{project_name}' 不存在")

        # 載入所有劇本
        scripts: dict[str, dict] = {}
        for ep in project_data.get("episodes", []):
            script_file = ep.get("script_file", "")
            if script_file:
                try:
                    scripts[script_file] = pm.load_script(project_name, script_file)
                except FileNotFoundError:
                    logger.debug("劇本檔案不存在，跳過: %s/%s", project_name, script_file)

        return project_data, scripts

    project_data, scripts = await asyncio.to_thread(_sync)

    resolver = ConfigResolver(async_session_factory)
    tracker = UsageTracker(session_factory=async_session_factory)
    service = CostEstimationService(resolver, tracker)

    try:
        return await service.compute(project_data, scripts, project_name=project_name)
    except Exception:
        logger.exception("費用估算失敗")
        raise HTTPException(status_code=500, detail="費用估算失敗，請稍後重試")
