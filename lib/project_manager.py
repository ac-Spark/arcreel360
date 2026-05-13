"""
專案檔案管理器

管理影片專案的目錄結構、分鏡劇本讀寫、狀態追蹤。
"""

import fcntl
import json
import logging
import os
import re
import secrets
import shutil
import tempfile
import unicodedata
from collections.abc import Callable
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from lib import agent_profile
from lib.project_change_hints import emit_project_change_hint

logger = logging.getLogger(__name__)

PROJECT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9-]+$")
PROJECT_SLUG_SANITIZER = re.compile(r"[^a-zA-Z0-9]+")


def _next_display_order(episodes: list[dict]) -> int:
    """回傳下一個顯示順序值（max(現有 order) + 1，無資料時為 0）。"""
    max_order = -1
    for ep in episodes:
        value = ep.get("order")
        if isinstance(value, int) and value > max_order:
            max_order = value
    return max_order + 1


# ==================== 資料模型 ====================


class ProjectOverview(BaseModel):
    """專案概述資料模型，用於 Gemini Structured Outputs"""

    synopsis: str = Field(description="故事梗概，200-300字，概括主線劇情")
    genre: str = Field(description="題材型別，如：古裝宮鬥、現代懸疑、玄幻修仙")
    theme: str = Field(description="核心主題，如：復仇與救贖、成長與蛻變")
    world_setting: str = Field(description="時代背景和世界觀設定，100-200字")


class ProjectManager:
    """影片專案管理器"""

    # 專案子目錄結構
    SUBDIRS = [
        "source",
        "scripts",
        "drafts",
        "characters",
        "clues",
        "storyboards",
        "videos",
        "thumbnails",
        "output",
    ]

    # 專案後設資料檔名
    PROJECT_FILE = "project.json"

    @staticmethod
    def normalize_project_name(name: str) -> str:
        """Validate and normalize a project identifier."""
        normalized = str(name).strip()
        if not normalized:
            raise ValueError("專案標識不能為空")
        if not PROJECT_NAME_PATTERN.fullmatch(normalized):
            raise ValueError("專案標識僅允許英文字母、數字和中劃線")
        return normalized

    @staticmethod
    def _slugify_project_title(title: str) -> str:
        """Build a filesystem-safe slug prefix from the project title."""
        ascii_text = unicodedata.normalize("NFKD", str(title).strip()).encode("ascii", "ignore").decode("ascii")
        slug = PROJECT_SLUG_SANITIZER.sub("-", ascii_text).strip("-_").lower()
        return slug[:24] or "project"

    def generate_project_name(self, title: str | None = None) -> str:
        """Generate a unique internal project identifier."""
        prefix = self._slugify_project_title(title or "")
        while True:
            candidate = f"{prefix}-{secrets.token_hex(4)}"
            if not (self.projects_root / candidate).exists():
                return candidate

    @classmethod
    def from_cwd(cls) -> tuple["ProjectManager", str]:
        """從當前工作目錄推斷 ProjectManager 和專案名稱。

        假定 cwd 為 ``projects/{project_name}/`` 格式。
        返回 ``(ProjectManager, project_name)`` 元組。
        """
        cwd = Path.cwd().resolve()
        project_name = cwd.name
        projects_root = cwd.parent
        pm = cls(projects_root)
        if not (projects_root / project_name / cls.PROJECT_FILE).exists():
            raise FileNotFoundError(f"當前目錄不是有效的專案目錄: {cwd}")
        return pm, project_name

    def __init__(self, projects_root: str | None = None):
        """
        初始化專案管理器

        Args:
            projects_root: 專案根目錄，預設為當前目錄下的 projects/
        """
        if projects_root is None:
            # 嘗試從環境變數或預設路徑獲取
            projects_root = os.environ.get("AI_ANIME_PROJECTS", "projects")

        self.projects_root = Path(projects_root)
        self.projects_root.mkdir(parents=True, exist_ok=True)

    def list_projects(self) -> list[str]:
        """列出所有專案"""
        return [d.name for d in self.projects_root.iterdir() if d.is_dir() and not d.name.startswith(".")]

    def create_project(self, name: str) -> Path:
        """
        建立新專案

        Args:
            name: 專案標識（全域性唯一，用於 URL 和檔案系統）

        Returns:
            專案目錄路徑
        """
        name = self.normalize_project_name(name)
        project_dir = self.projects_root / name

        if project_dir.exists():
            raise FileExistsError(f"專案 '{name}' 已存在")

        # 建立所有子目錄
        for subdir in self.SUBDIRS:
            (project_dir / subdir).mkdir(parents=True, exist_ok=True)

        self.repair_claude_symlink(project_dir)

        return project_dir

    def repair_claude_symlink(self, project_dir: Path) -> dict:
        """修復專案目錄的 .claude 和 CLAUDE.md 軟連線。

        對每條軟連線執行：
        - 損壞（is_symlink but not exists）→ 刪除並重建
        - 缺失（not exists and not is_symlink）→ 建立
        - 正常（exists）→ 跳過

        Returns:
            {"created": int, "repaired": int, "skipped": int, "errors": int}
        """
        symlink_targets = agent_profile.project_symlink_targets(self.projects_root.parent)
        relative_targets = agent_profile.project_symlink_relative_targets()

        stats = {"created": 0, "repaired": 0, "skipped": 0, "errors": 0}
        for name, target_source in symlink_targets.items():
            if not target_source.exists():
                continue
            symlink_path = project_dir / name
            if symlink_path.is_symlink() and not symlink_path.exists():
                # 損壞的軟連線
                try:
                    symlink_path.unlink()
                    symlink_path.symlink_to(relative_targets[name])
                    stats["repaired"] += 1
                except OSError as e:
                    logger.warning("無法修復專案 %s 的 %s 符號連結: %s", project_dir.name, name, e)
                    stats["errors"] += 1
            elif not symlink_path.exists() and not symlink_path.is_symlink():
                # 缺失
                try:
                    symlink_path.symlink_to(relative_targets[name])
                    stats["created"] += 1
                except OSError as e:
                    logger.warning("無法為專案 %s 建立 %s 符號連結: %s", project_dir.name, name, e)
                    stats["errors"] += 1
            else:
                stats["skipped"] += 1
        return stats

    def repair_all_symlinks(self) -> dict:
        """掃描所有專案目錄，修復軟連線。

        Returns:
            {"created": int, "repaired": int, "skipped": int, "errors": int}
        """
        totals = {"created": 0, "repaired": 0, "skipped": 0, "errors": 0}
        if not self.projects_root.exists():
            return totals
        for project_dir in sorted(self.projects_root.iterdir()):
            if not project_dir.is_dir() or project_dir.name.startswith("."):
                continue
            try:
                result = self.repair_claude_symlink(project_dir)
                for key in ("created", "repaired", "skipped", "errors"):
                    totals[key] += result.get(key, 0)
            except Exception as e:
                logger.warning("修復專案 %s 軟連線時出錯: %s", project_dir.name, e)
                totals["errors"] += 1
        return totals

    def get_project_path(self, name: str) -> Path:
        """獲取專案路徑（含路徑遍歷防護）"""
        name = self.normalize_project_name(name)
        real = os.path.realpath(self.projects_root / name)
        base = os.path.realpath(self.projects_root) + os.sep
        if not real.startswith(base):
            raise ValueError(f"非法專案名稱: '{name}'")
        project_dir = Path(real)
        if not project_dir.exists():
            raise FileNotFoundError(f"專案 '{name}' 不存在")
        return project_dir

    @staticmethod
    def _safe_subpath(base_dir: Path, filename: str) -> str:
        """校驗 filename 拼接後不逃出 base_dir，返回 realpath 字串。"""
        real = os.path.realpath(base_dir / filename)
        bound = os.path.realpath(base_dir) + os.sep
        if not real.startswith(bound):
            raise ValueError(f"非法檔名: '{filename}'")
        return real

    def get_project_status(self, name: str) -> dict[str, Any]:
        """
        獲取專案狀態

        Returns:
            包含各階段完成情況的字典
        """
        project_dir = self.get_project_path(name)

        status = {
            "name": name,
            "path": str(project_dir),
            "source_files": [],
            "scripts": [],
            "characters": [],
            "clues": [],
            "storyboards": [],
            "videos": [],
            "outputs": [],
            "current_stage": "empty",
        }

        # 檢查各目錄內容
        for subdir in self.SUBDIRS:
            subdir_path = project_dir / subdir
            if subdir_path.exists():
                files = list(subdir_path.glob("*"))
                if subdir == "source":
                    status["source_files"] = [f.name for f in files if f.is_file()]
                elif subdir == "scripts":
                    status["scripts"] = [f.name for f in files if f.suffix == ".json"]
                elif subdir == "characters":
                    status["characters"] = [f.name for f in files if f.suffix in [".png", ".jpg", ".jpeg"]]
                elif subdir == "clues":
                    status["clues"] = [f.name for f in files if f.suffix in [".png", ".jpg", ".jpeg"]]
                elif subdir == "storyboards":
                    status["storyboards"] = [f.name for f in files if f.suffix in [".png", ".jpg", ".jpeg"]]
                elif subdir == "videos":
                    status["videos"] = [f.name for f in files if f.suffix in [".mp4", ".webm"]]
                elif subdir == "output":
                    status["outputs"] = [f.name for f in files if f.suffix in [".mp4", ".webm"]]

        # 確定當前階段
        if status["outputs"]:
            status["current_stage"] = "completed"
        elif status["videos"]:
            status["current_stage"] = "videos_generated"
        elif status["storyboards"]:
            status["current_stage"] = "storyboards_generated"
        elif status["characters"]:
            status["current_stage"] = "characters_generated"
        elif status["scripts"]:
            status["current_stage"] = "script_created"
        elif status["source_files"]:
            status["current_stage"] = "source_ready"
        else:
            status["current_stage"] = "empty"

        return status

    # ==================== 分鏡劇本操作 ====================

    def create_script(self, project_name: str, title: str, chapter: str) -> dict:
        """
        建立新的分鏡劇本模板

        Args:
            project_name: 專案名稱
            title: 小說標題
            chapter: 章節名稱

        Returns:
            劇本字典
        """
        script = {
            "novel": {"title": title, "chapter": chapter},
            "scenes": [],
            "metadata": {
                "created_at": datetime.now().isoformat(),
                "updated_at": datetime.now().isoformat(),
                "total_scenes": 0,
                "estimated_duration_seconds": 0,
                "status": "draft",
            },
        }

        return script

    def save_script(self, project_name: str, script: dict, filename: str | None = None) -> Path:
        """
        儲存分鏡劇本

        Args:
            project_name: 專案名稱
            script: 劇本字典
            filename: 可選的檔名，預設使用章節名

        Returns:
            儲存的檔案路徑
        """
        project_dir = self.get_project_path(project_name)
        scripts_dir = project_dir / "scripts"

        if filename is not None and filename.startswith("scripts/"):
            filename = filename[len("scripts/") :]

        if filename is None:
            chapter = script["novel"].get("chapter", "chapter_01")
            filename = f"{chapter.replace(' ', '_')}_script.json"

        # 更新後設資料（相容舊指令碼：可能缺少 metadata，或 narration 使用 segments）
        now = datetime.now().isoformat()
        metadata = script.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
            script["metadata"] = metadata
        metadata.setdefault("created_at", now)
        metadata.setdefault("status", "draft")
        metadata["updated_at"] = now

        scenes = script.get("scenes", [])
        if not isinstance(scenes, list):
            scenes = []
        segments = script.get("segments", [])
        if not isinstance(segments, list):
            segments = []

        content_mode = script.get("content_mode", "narration")
        if content_mode == "narration" and segments:
            items = segments
            items_type = "segments"
        elif scenes:
            items = scenes
            items_type = "scenes"
        else:
            items = segments
            items_type = "segments"

        metadata["total_scenes"] = len(items)

        # 計算總時長：按當前選中的資料結構決定回退值，避免 content_mode 缺失時誤判
        default_duration = 4 if items_type == "segments" else 8
        total_duration = sum(item.get("duration_seconds", default_duration) for item in items)
        metadata["estimated_duration_seconds"] = total_duration

        # 儲存檔案（含路徑遍歷防護）
        real = self._safe_subpath(scripts_dir, filename)
        with open(real, "w", encoding="utf-8") as f:  # noqa: PTH123
            json.dump(script, f, ensure_ascii=False, indent=2)
        output_path = Path(real)

        emit_project_change_hint(
            project_name,
            changed_paths=[f"scripts/{output_path.name}"],
        )

        # 自動同步到 project.json
        if self.project_exists(project_name) and isinstance(script.get("episode"), int):
            self.sync_episode_from_script(project_name, filename)

        return output_path

    def sync_episode_from_script(self, project_name: str, script_filename: str) -> dict:
        """
        從劇本檔案同步集數資訊到 project.json

        Agent 寫入劇本後必須呼叫此方法以確保 WebUI 能正確顯示劇集列表。

        Args:
            project_name: 專案名稱
            script_filename: 劇本檔名（如 episode_1.json）

        Returns:
            更新後的 project 字典
        """
        script = self.load_script(project_name, script_filename)
        project = self.load_project(project_name)

        episode_num = script.get("episode", 1)
        episode_title = script.get("title", "")
        script_file = f"scripts/{script_filename}"

        # 查詢或建立 episode 條目
        episodes = project.setdefault("episodes", [])
        episode_entry = next((ep for ep in episodes if ep["episode"] == episode_num), None)

        if episode_entry is None:
            episode_entry = {"episode": episode_num, "order": _next_display_order(episodes)}
            episodes.append(episode_entry)

        # 同步核心後設資料（不包含統計欄位，統計欄位由 StatusCalculator 讀時計算）
        episode_entry["title"] = episode_title
        episode_entry["script_file"] = script_file

        # 排序並儲存
        episodes.sort(key=lambda x: x["episode"])
        self.save_project(project_name, project)

        logger.info("已同步劇集資訊: Episode %d - %s", episode_num, episode_title)
        return project

    def load_script(self, project_name: str, filename: str) -> dict:
        """
        載入分鏡劇本

        Args:
            project_name: 專案名稱
            filename: 劇本檔名

        Returns:
            劇本字典
        """
        project_dir = self.get_project_path(project_name)
        if filename.startswith("scripts/"):
            filename = filename[len("scripts/") :]
        real = self._safe_subpath(project_dir / "scripts", filename)

        if not os.path.exists(real):
            raise FileNotFoundError(f"劇本檔案不存在: {real}")

        with open(real, encoding="utf-8") as f:  # noqa: PTH123
            return json.load(f)

    def list_scripts(self, project_name: str) -> list[str]:
        """列出專案中的所有劇本"""
        project_dir = self.get_project_path(project_name)
        scripts_dir = project_dir / "scripts"
        return [f.name for f in scripts_dir.glob("*.json")]

    # ==================== 角色管理 ====================

    def update_character_sheet(self, project_name: str, script_filename: str, name: str, sheet_path: str) -> dict:
        """更新角色設計圖路徑"""
        script = self.load_script(project_name, script_filename)

        if name not in script["characters"]:
            raise KeyError(f"角色 '{name}' 不存在")

        script["characters"][name]["character_sheet"] = sheet_path
        self.save_script(project_name, script, script_filename)
        return script

    # ==================== 資料結構標準化 ====================

    @staticmethod
    def create_generated_assets(content_mode: str = "narration") -> dict:
        """
        建立標準的 generated_assets 結構

        Args:
            content_mode: 內容模式（'narration' 或 'drama'）

        Returns:
            標準的 generated_assets 字典
        """
        return {
            "storyboard_image": None,
            "video_clip": None,
            "video_thumbnail": None,
            "video_uri": None,
            "status": "pending",
        }

    @staticmethod
    def create_scene_template(scene_id: str, episode: int = 1, duration_seconds: int = 8) -> dict:
        """
        建立標準場景物件模板

        Args:
            scene_id: 場景 ID（如 "E1S01"）
            episode: 集數編號
            duration_seconds: 場景時長（秒）

        Returns:
            標準的場景字典
        """
        return {
            "scene_id": scene_id,
            "episode": episode,
            "title": "",
            "scene_type": "劇情",
            "duration_seconds": duration_seconds,
            "segment_break": False,
            "characters_in_scene": [],
            "clues_in_scene": [],
            "visual": {
                "description": "",
                "shot_type": "medium shot",
                "camera_movement": "static",
                "lighting": "",
                "mood": "",
            },
            "action": "",
            "dialogue": {"speaker": "", "text": "", "emotion": "neutral"},
            "audio": {"dialogue": [], "narration": "", "sound_effects": []},
            "transition_to_next": "cut",
            "generated_assets": ProjectManager.create_generated_assets(),
        }

    def normalize_scene(self, scene: dict, episode: int = 1) -> dict:
        """
        補全單個場景中缺失的欄位

        Args:
            scene: 場景字典
            episode: 集數編號（用於補全 episode 欄位）

        Returns:
            補全後的場景字典
        """
        template = self.create_scene_template(
            scene_id=scene.get("scene_id", "000"),
            episode=episode,
            duration_seconds=scene.get("duration_seconds", 8),
        )

        # 合併 visual 欄位
        if "visual" not in scene:
            scene["visual"] = template["visual"]
        else:
            for key in template["visual"]:
                if key not in scene["visual"]:
                    scene["visual"][key] = template["visual"][key]

        # 合併 audio 欄位
        if "audio" not in scene:
            scene["audio"] = template["audio"]
        else:
            for key in template["audio"]:
                if key not in scene["audio"]:
                    scene["audio"][key] = template["audio"][key]

        # 補全 generated_assets 欄位
        if "generated_assets" not in scene:
            scene["generated_assets"] = self.create_generated_assets()
        else:
            assets_template = self.create_generated_assets()
            for key in assets_template:
                if key not in scene["generated_assets"]:
                    scene["generated_assets"][key] = assets_template[key]

        # 補全其他頂層欄位
        top_level_defaults = {
            "episode": episode,
            "title": "",
            "scene_type": "劇情",
            "segment_break": False,
            "characters_in_scene": [],
            "clues_in_scene": [],
            "action": "",
            "dialogue": template["dialogue"],
            "transition_to_next": "cut",
        }

        for key, default_value in top_level_defaults.items():
            if key not in scene:
                scene[key] = default_value

        # 更新狀態
        self.update_scene_status(scene)

        return scene

    def update_scene_status(self, scene: dict) -> str:
        """
        根據 generated_assets 內容更新並返回場景狀態

        狀態值:
        - pending: 未開始
        - storyboard_ready: 分鏡圖完成
        - completed: 影片完成

        Args:
            scene: 場景字典

        Returns:
            更新後的狀態值
        """
        assets = scene.get("generated_assets", {})

        has_image = bool(assets.get("storyboard_image"))
        has_video = bool(assets.get("video_clip"))

        if has_video:
            status = "completed"
        elif has_image:
            status = "storyboard_ready"
        else:
            status = "pending"

        assets["status"] = status
        return status

    def normalize_script(self, project_name: str, script_filename: str, save: bool = True) -> dict:
        """
        補全現有 script.json 中缺失的欄位

        Args:
            project_name: 專案名稱
            script_filename: 劇本檔名
            save: 是否儲存修改後的劇本

        Returns:
            補全後的劇本字典
        """
        import re

        script = self.load_script(project_name, script_filename)

        # 從檔名或現有資料推斷 episode
        episode = script.get("episode", 1)
        if not episode:
            match = re.search(r"episode[_\s]*(\d+)", script_filename, re.IGNORECASE)
            if match:
                episode = int(match.group(1))
            else:
                episode = 1

        # 補全頂層欄位
        script_defaults = {
            "episode": episode,
            "title": script.get("novel", {}).get("chapter", ""),
            "duration_seconds": 0,
            "summary": "",
        }

        for key, default_value in script_defaults.items():
            if key not in script:
                script[key] = default_value

        # 確保必要的頂層結構存在
        if "novel" not in script:
            script["novel"] = {"title": "", "chapter": ""}
        # 剝離已廢棄的 source_file 欄位
        if isinstance(script.get("novel"), dict):
            script["novel"].pop("source_file", None)

        # 處理舊格式：如果有 characters 物件，同步到 project.json
        if "characters" in script and isinstance(script["characters"], dict) and script["characters"]:
            logger.warning("檢測到舊格式 characters 物件，自動同步到 project.json")
            self.sync_characters_from_script(project_name, script_filename)
            # sync_characters_from_script 會重新載入和儲存 script，所以需要重新載入
            script = self.load_script(project_name, script_filename)

        # 處理舊格式：如果有 clues 物件，同步到 project.json
        if "clues" in script and isinstance(script["clues"], dict) and script["clues"]:
            logger.warning("檢測到舊格式 clues 物件，自動同步到 project.json")
            self.sync_clues_from_script(project_name, script_filename)
            script = self.load_script(project_name, script_filename)

        # 注意：characters_in_episode 和 clues_in_episode 已改為讀時計算
        # 不再在 normalize_script 中建立這些欄位

        if "scenes" not in script:
            script["scenes"] = []

        if "metadata" not in script:
            script["metadata"] = {
                "created_at": datetime.now().isoformat(),
                "updated_at": datetime.now().isoformat(),
                "total_scenes": 0,
                "estimated_duration_seconds": 0,
                "status": "draft",
            }

        # 規範化每個場景
        for scene in script["scenes"]:
            self.normalize_scene(scene, episode)

        # 更新統計資訊
        script["metadata"]["total_scenes"] = len(script["scenes"])
        script["metadata"]["estimated_duration_seconds"] = sum(s.get("duration_seconds", 8) for s in script["scenes"])
        script["duration_seconds"] = script["metadata"]["estimated_duration_seconds"]

        if save:
            self.save_script(project_name, script, script_filename)
            logger.info("劇本已規範化並儲存: %s", script_filename)

        return script

    # ==================== 場景管理 ====================

    def add_scene(self, project_name: str, script_filename: str, scene: dict) -> dict:
        """
        向劇本新增場景

        Args:
            project_name: 專案名稱
            script_filename: 劇本檔名
            scene: 場景字典

        Returns:
            更新後的劇本
        """
        script = self.load_script(project_name, script_filename)

        # 自動生成場景 ID
        existing_ids = [s["scene_id"] for s in script["scenes"]]
        next_id = f"{len(existing_ids) + 1:03d}"
        scene["scene_id"] = next_id

        # 確保有 generated_assets 欄位
        if "generated_assets" not in scene:
            scene["generated_assets"] = {
                "storyboard_image": None,
                "video_clip": None,
                "status": "pending",
            }

        script["scenes"].append(scene)
        self.save_script(project_name, script, script_filename)
        return script

    def update_scene_asset(
        self,
        project_name: str,
        script_filename: str,
        scene_id: str,
        asset_type: str,
        asset_path: str,
    ) -> dict:
        """
        更新場景的生成資源路徑

        Args:
            project_name: 專案名稱
            script_filename: 劇本檔名
            scene_id: 場景/片段 ID
            asset_type: 資源型別 ('storyboard_image' 或 'video_clip')
            asset_path: 資源路徑

        Returns:
            更新後的劇本
        """
        script = self.load_script(project_name, script_filename)

        # 根據內容模式選擇正確的資料結構
        content_mode = script.get("content_mode", "narration")
        if content_mode == "narration" and "segments" in script:
            items = script["segments"]
            id_field = "segment_id"
        else:
            items = script.get("scenes", [])
            id_field = "scene_id"

        for item in items:
            if str(item.get(id_field)) == str(scene_id):
                assets = item.get("generated_assets")
                if not isinstance(assets, dict):
                    assets = {}
                    item["generated_assets"] = assets

                assets_template = self.create_generated_assets(content_mode)
                for key, default_value in assets_template.items():
                    if key not in assets:
                        assets[key] = default_value

                assets[asset_type] = asset_path

                # 使用 update_scene_status 更新狀態
                self.update_scene_status(item)

                self.save_script(project_name, script, script_filename)
                return script

        raise KeyError(f"場景 '{scene_id}' 不存在")

    def get_pending_scenes(self, project_name: str, script_filename: str, asset_type: str) -> list[dict]:
        """
        獲取待處理的場景/片段列表

        Args:
            project_name: 專案名稱
            script_filename: 劇本檔名
            asset_type: 資源型別

        Returns:
            待處理場景/片段列表
        """
        script = self.load_script(project_name, script_filename)

        # 根據內容模式選擇正確的資料結構
        content_mode = script.get("content_mode", "narration")
        if content_mode == "narration" and "segments" in script:
            items = script["segments"]
        else:
            items = script.get("scenes", [])

        return [item for item in items if not item["generated_assets"].get(asset_type)]

    # ==================== 檔案路徑工具 ====================

    def get_source_path(self, project_name: str, filename: str) -> Path:
        """獲取原始檔路徑"""
        return self.get_project_path(project_name) / "source" / filename

    def get_character_path(self, project_name: str, filename: str) -> Path:
        """獲取角色設計圖路徑"""
        return self.get_project_path(project_name) / "characters" / filename

    def get_storyboard_path(self, project_name: str, filename: str) -> Path:
        """獲取分鏡圖片路徑"""
        return self.get_project_path(project_name) / "storyboards" / filename

    def get_video_path(self, project_name: str, filename: str) -> Path:
        """獲取影片路徑"""
        return self.get_project_path(project_name) / "videos" / filename

    def get_output_path(self, project_name: str, filename: str) -> Path:
        """獲取輸出路徑"""
        return self.get_project_path(project_name) / "output" / filename

    def get_scenes_needing_storyboard(self, project_name: str, script_filename: str) -> list[dict]:
        """
        獲取需要生成分鏡圖的場景/片段列表（兩種模式統一邏輯）

        Args:
            project_name: 專案名稱
            script_filename: 劇本檔名

        Returns:
            需要生成分鏡圖的場景/片段列表
        """
        script = self.load_script(project_name, script_filename)

        content_mode = script.get("content_mode", "narration")
        if content_mode == "narration" and "segments" in script:
            items = script["segments"]
        else:
            items = script.get("scenes", [])

        return [item for item in items if not item.get("generated_assets", {}).get("storyboard_image")]

    # ==================== 專案級後設資料管理 ====================

    def _get_project_file_path(self, project_name: str) -> Path:
        """獲取專案後設資料檔案路徑"""
        return self.get_project_path(project_name) / self.PROJECT_FILE

    def project_exists(self, project_name: str) -> bool:
        """檢查專案後設資料檔案是否存在"""
        try:
            return self._get_project_file_path(project_name).exists()
        except FileNotFoundError:
            return False

    def load_project(self, project_name: str) -> dict:
        """
        載入專案後設資料

        Args:
            project_name: 專案名稱

        Returns:
            專案後設資料字典
        """
        project_file = self._get_project_file_path(project_name)

        if not project_file.exists():
            raise FileNotFoundError(f"專案後設資料檔案不存在: {project_file}")

        with open(project_file, encoding="utf-8") as f:
            return json.load(f)

    @contextmanager
    def _project_lock(self, project_name: str):
        """透過專用 lock file 獲取專案後設資料的排他鎖。

        使用獨立的 .project.json.lock 而非資料檔案本身，避免 os.replace
        更換 inode 後鎖失效的問題。
        """
        lock_path = self._get_project_file_path(project_name).with_suffix(".lock")
        lock_path.touch(exist_ok=True)
        fd = open(lock_path)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            fd.close()

    @staticmethod
    def _atomic_write_json(path: Path, data: dict) -> None:
        """透過臨時檔案 + os.replace 原子寫入 JSON。"""
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=str(path.parent),
                prefix=".project.",
                suffix=".tmp",
                delete=False,
            ) as tmp:
                json.dump(data, tmp, ensure_ascii=False, indent=2)
                tmp_path = Path(tmp.name)
            os.replace(tmp_path, path)
            tmp_path = None
        finally:
            if tmp_path is not None:
                try:
                    tmp_path.unlink()
                except OSError:
                    pass

    def save_project(self, project_name: str, project: dict) -> Path:
        """
        儲存專案後設資料

        Args:
            project_name: 專案名稱
            project: 專案後設資料字典

        Returns:
            儲存的檔案路徑
        """
        project_file = self._get_project_file_path(project_name)

        self._touch_metadata(project)

        with self._project_lock(project_name):
            self._atomic_write_json(project_file, project)

        emit_project_change_hint(
            project_name,
            changed_paths=[self.PROJECT_FILE],
        )

        return project_file

    def update_project(
        self,
        project_name: str,
        mutate_fn: Callable[[dict], None],
    ) -> Path:
        """原子性地更新 project.json：加檔案鎖 → 讀 → 修改 → 原子寫回。

        避免併發任務（如同時生成多張角色圖片）之間的 lost-update 競態。

        Args:
            project_name: 專案名稱
            mutate_fn: 接收 project dict 並就地修改的回撥函式
        """
        project_file = self._get_project_file_path(project_name)

        with self._project_lock(project_name):
            with open(project_file, encoding="utf-8") as f:
                project = json.load(f)
            mutate_fn(project)
            self._touch_metadata(project)
            self._atomic_write_json(project_file, project)

        emit_project_change_hint(
            project_name,
            changed_paths=[self.PROJECT_FILE],
        )

        return project_file

    @staticmethod
    def _touch_metadata(project: dict) -> None:
        now = datetime.now().isoformat()
        if "metadata" not in project:
            project["metadata"] = {"created_at": now, "updated_at": now}
        else:
            project["metadata"]["updated_at"] = now

    def create_project_metadata(
        self,
        project_name: str,
        title: str | None = None,
        style: str | None = None,
        content_mode: str = "narration",
        aspect_ratio: str = "9:16",
        default_duration: int | None = None,
    ) -> dict:
        """
        建立新的專案後設資料檔案

        Args:
            project_name: 專案標識
            title: 專案標題，留空時預設使用專案標識
            style: 整體視覺風格描述
            content_mode: 內容模式 ('narration' 或 'drama')
            aspect_ratio: 影片寬高比（獨立於 content_mode）
            default_duration: 預設影片時長（秒），None 表示使用系統預設值

        Returns:
            專案後設資料字典
        """
        project_name = self.normalize_project_name(project_name)
        project_title = str(title).strip() if title is not None else ""

        project = {
            "title": project_title or project_name,
            "content_mode": content_mode,
            "aspect_ratio": aspect_ratio,
            "style": style or "",
            "episodes": [],
            "characters": {},
            "clues": {},
            "metadata": {
                "created_at": datetime.now().isoformat(),
                "updated_at": datetime.now().isoformat(),
            },
        }
        if default_duration is not None:
            project["default_duration"] = default_duration

        self.save_project(project_name, project)
        return project

    def add_episode(self, project_name: str, episode: int, title: str, script_file: str) -> dict:
        """
        向專案新增劇集

        Args:
            project_name: 專案名稱
            episode: 集數
            title: 劇集標題
            script_file: 劇本檔案相對路徑

        Returns:
            更新後的專案後設資料
        """
        project = self.load_project(project_name)

        # 檢查是否已存在
        for ep in project["episodes"]:
            if ep["episode"] == episode:
                ep["title"] = title
                ep["script_file"] = script_file
                self.save_project(project_name, project)
                return project

        # 新增新劇集（不包含統計欄位，由 StatusCalculator 讀時計算）
        next_order = _next_display_order(project["episodes"])
        project["episodes"].append(
            {"episode": episode, "title": title, "script_file": script_file, "order": next_order}
        )

        # 按集數排序（陣列物理順序仍以集數遞增，顯示順序由 order 欄位決定）
        project["episodes"].sort(key=lambda x: x["episode"])

        self.save_project(project_name, project)
        return project

    def reorder_episodes(self, project_name: str, ordered_episode_numbers: list[int]) -> dict:
        """依指定的集數順序重設每個 episode 的 ``order`` 欄位。

        Args:
            project_name: 專案名稱
            ordered_episode_numbers: 期望的顯示順序（用集數編號表示）。
                必須與專案現存集數恰好相同（同集合、同個數，不能多也不能少）。

        Returns:
            更新後的 project 字典。

        Raises:
            ValueError: 傳入集數與現存不匹配（缺漏、多餘或重複）。
        """
        project = self.load_project(project_name)
        episodes = project.get("episodes", [])
        existing = [int(ep.get("episode", -1)) for ep in episodes]
        requested = [int(n) for n in ordered_episode_numbers]
        if sorted(existing) != sorted(requested):
            raise ValueError(f"傳入的集數與現存劇集不一致：現存 {sorted(existing)}，傳入 {sorted(requested)}")
        if len(set(requested)) != len(requested):
            raise ValueError(f"傳入的集數有重複：{requested}")

        order_map = {ep_num: idx for idx, ep_num in enumerate(requested)}
        for ep in episodes:
            ep["order"] = order_map[int(ep.get("episode"))]

        self.save_project(project_name, project)
        return project

    def remove_episode(self, project_name: str, episode: int) -> tuple[dict, list[str]]:
        """從專案移除一整集。

        會刪除：劇本檔（scripts/episode_N.json）、預處理草稿（drafts/episode_N/）、
        分集切分產生的 source/episode_N.txt、合成輸出（output/episode_N*.{mp4,webm}）、
        該集所有片段/場景對應的分鏡/影片/縮圖與版本檔（versions/）及 versions.json 內的條目，
        最後從 project.json 的 episodes 移除該條目。

        Args:
            project_name: 專案名稱
            episode: 集數

        Returns:
            (更新後的 project dict, 已刪除的相對路徑清單)

        Raises:
            KeyError: 該集不存在於 project.json。
        """
        project = self.load_project(project_name)
        episodes = project.get("episodes", [])
        entry = next((ep for ep in episodes if int(ep.get("episode", -1)) == int(episode)), None)
        if entry is None:
            raise KeyError(f"劇集 E{episode} 不存在")

        project_dir = self.get_project_path(project_name)
        removed: list[str] = []
        ep_prefix = f"E{int(episode)}S"

        def _rm_file(rel: str) -> None:
            p = project_dir / rel
            if p.is_file():
                p.unlink()
                removed.append(rel)

        def _rm_dir(rel: str) -> None:
            p = project_dir / rel
            if p.is_dir():
                shutil.rmtree(p)
                removed.append(rel.rstrip("/") + "/")

        # 收集該集所有片段/場景 id（劇本可能損毀或不存在 → 退回前綴掃描）
        script_rel = entry.get("script_file") or f"scripts/episode_{episode}.json"
        script_name = script_rel[len("scripts/") :] if script_rel.startswith("scripts/") else script_rel
        segment_ids: set[str] = set()
        try:
            script = self.load_script(project_name, script_name)
            for key in ("segments", "scenes"):
                for item in script.get(key, []) or []:
                    sid = item.get("segment_id") or item.get("scene_id")
                    if isinstance(sid, str) and sid:
                        segment_ids.add(sid)
        except (FileNotFoundError, json.JSONDecodeError, ValueError, AttributeError):
            pass

        def _id_hit(resource_id: str) -> bool:
            return resource_id in segment_ids if segment_ids else resource_id.startswith(ep_prefix)

        # 1) 劇本檔
        _rm_file(f"scripts/{script_name}")
        # 2) 預處理草稿目錄
        _rm_dir(f"drafts/episode_{episode}")
        # 3) 分集切分產生的 source/episode_N.txt
        _rm_file(f"source/episode_{episode}.txt")
        # 4) 合成輸出 output/episode_N*.{mp4,webm}
        output_dir = project_dir / "output"
        if output_dir.is_dir():
            for f in sorted(output_dir.iterdir()):
                if f.is_file() and f.name.startswith(f"episode_{episode}") and f.suffix.lower() in (".mp4", ".webm"):
                    f.unlink()
                    removed.append(f"output/{f.name}")
        # 5) 各片段/場景的分鏡、影片、縮圖（檔名格式：scene_{id}.{ext}）
        media_dirs = {
            "storyboards": (".png", ".jpg", ".jpeg"),
            "videos": (".mp4", ".webm"),
            "thumbnails": (".png", ".jpg", ".jpeg"),
        }
        for sub, exts in media_dirs.items():
            d = project_dir / sub
            if not d.is_dir():
                continue
            for f in sorted(d.iterdir()):
                if not f.is_file() or f.suffix.lower() not in exts:
                    continue
                stem = f.stem
                resource_id = stem[len("scene_") :] if stem.startswith("scene_") else stem
                if _id_hit(resource_id):
                    f.unlink()
                    removed.append(f"{sub}/{f.name}")
        # 6) versions/ 目錄檔案與 versions.json 條目（檔名格式：{id}_v{n}_{timestamp}.{ext}）
        versions_dir = project_dir / "versions"
        if versions_dir.is_dir():
            for rt in ("storyboards", "videos"):
                rt_dir = versions_dir / rt
                if not rt_dir.is_dir():
                    continue
                for f in sorted(rt_dir.iterdir()):
                    if not f.is_file():
                        continue
                    resource_id = f.name.split("_v", 1)[0]
                    if _id_hit(resource_id):
                        f.unlink()
                        removed.append(f"versions/{rt}/{f.name}")
            versions_file = versions_dir / "versions.json"
            if versions_file.is_file():
                try:
                    with open(versions_file, encoding="utf-8") as fh:  # noqa: PTH123
                        vdata = json.load(fh)
                    changed = False
                    for rt in ("storyboards", "videos"):
                        bucket = vdata.get(rt)
                        if not isinstance(bucket, dict):
                            continue
                        for resource_id in list(bucket.keys()):
                            if _id_hit(resource_id):
                                del bucket[resource_id]
                                changed = True
                    if changed:
                        with open(versions_file, "w", encoding="utf-8") as fh:  # noqa: PTH123
                            json.dump(vdata, fh, ensure_ascii=False, indent=2)
                        removed.append("versions/versions.json")
                except (json.JSONDecodeError, OSError):
                    pass

        # 7) 從 project.json 移除該集
        project["episodes"] = [ep for ep in episodes if int(ep.get("episode", -1)) != int(episode)]
        self.save_project(project_name, project)
        return project, removed

    def commit_episode_split(
        self,
        project_name: str,
        source_rel: str,
        episode: int,
        part_before: str,
        part_after: str,
        title: str | None = None,
    ) -> dict:
        """落地一次分集切分。

        - 寫 source/episode_{episode}.txt（= part_before）
        - 寫 source/_remaining.txt（= part_after）—— 下一集的新起點
        - 原始 source 檔不修改
        - 在 project.json 的 episodes 加/更新 {episode, title?}（已存在則只更新 title）

        Args:
            source_rel: 來源檔相對路徑（須在 source/ 下），僅用於路徑安全檢查。
        Returns:
            更新後的 project dict。
        Raises:
            ValueError: source_rel 不在 source/ 目錄內。
        """
        project_dir = self.get_project_path(project_name)
        # 路徑安全：source_rel 必須落在 project_dir/source/ 內
        src_abs = (project_dir / source_rel).resolve()
        source_dir = (project_dir / "source").resolve()
        if not src_abs.is_relative_to(source_dir):
            raise ValueError(f"source 路徑超出 source/ 目錄: {source_rel}")
        source_dir.mkdir(parents=True, exist_ok=True)

        (source_dir / f"episode_{episode}.txt").write_text(part_before, encoding="utf-8")
        (source_dir / "_remaining.txt").write_text(part_after, encoding="utf-8")

        project = self.load_project(project_name)
        episodes = project.setdefault("episodes", [])
        existing: dict | None = next((ep for ep in episodes if int(ep.get("episode", -1)) == int(episode)), None)
        if existing is None:
            existing = {"episode": int(episode), "order": _next_display_order(episodes)}
            episodes.append(existing)
        if title is not None:
            existing["title"] = title
        episodes.sort(key=lambda ep: int(ep.get("episode", 0)))
        self.save_project(project_name, project)
        logger.info(
            "分集切分落地: episode %d，前半 %d 字元，後半 %d 字元",
            episode,
            len(part_before),
            len(part_after),
        )
        return project

    def sync_project_status(self, project_name: str) -> dict:
        """
        [已廢棄] 同步專案狀態

        此方法已廢棄。status、progress、scenes_count 等統計欄位
        現在由 StatusCalculator 讀時計算，不再儲存在 JSON 檔案中。

        保留此方法僅為向後相容，實際不執行任何寫入操作。

        Args:
            project_name: 專案名稱

        Returns:
            專案後設資料（不含統計欄位，統計欄位由 StatusCalculator 注入）
        """
        import warnings

        warnings.warn(
            "sync_project_status() 已廢棄。status 等統計欄位現由 StatusCalculator 讀時計算。",
            DeprecationWarning,
            stacklevel=2,
        )
        # 僅返回專案資料，不執行任何寫入
        return self.load_project(project_name)

    # ==================== 專案級角色管理 ====================

    def add_project_character(
        self,
        project_name: str,
        name: str,
        description: str,
        voice_style: str | None = None,
        character_sheet: str | None = None,
    ) -> dict:
        """
        向專案新增角色（專案級）

        Args:
            project_name: 專案名稱
            name: 角色名稱
            description: 角色描述
            voice_style: 聲音風格
            character_sheet: 角色設計圖路徑

        Returns:
            更新後的專案後設資料
        """
        project = self.load_project(project_name)

        project.setdefault("characters", {})[name] = {
            "description": description,
            "voice_style": voice_style or "",
            "character_sheet": character_sheet or "",
        }

        self.save_project(project_name, project)
        return project

    def update_project_character_sheet(self, project_name: str, name: str, sheet_path: str) -> dict:
        """更新專案級角色設計圖路徑"""
        project = self.load_project(project_name)

        if name not in project["characters"]:
            raise KeyError(f"角色 '{name}' 不存在")

        project["characters"][name]["character_sheet"] = sheet_path
        self.save_project(project_name, project)
        return project

    def update_character_reference_image(self, project_name: str, char_name: str, ref_path: str) -> dict:
        """
        更新角色的參考圖路徑

        Args:
            project_name: 專案名稱
            char_name: 角色名稱
            ref_path: 參考圖相對路徑

        Returns:
            更新後的專案資料
        """
        project = self.load_project(project_name)

        if "characters" not in project or char_name not in project["characters"]:
            raise KeyError(f"角色 '{char_name}' 不存在")

        project["characters"][char_name]["reference_image"] = ref_path
        self.save_project(project_name, project)
        return project

    def get_project_character(self, project_name: str, name: str) -> dict:
        """獲取專案級角色定義"""
        project = self.load_project(project_name)

        if name not in project["characters"]:
            raise KeyError(f"角色 '{name}' 不存在")

        return project["characters"][name]

    # ==================== 線索管理 ====================

    def update_clue_sheet(self, project_name: str, name: str, sheet_path: str) -> dict:
        """
        更新線索設計圖路徑

        Args:
            project_name: 專案名稱
            name: 線索名稱
            sheet_path: 設計圖路徑

        Returns:
            更新後的專案後設資料
        """
        project = self.load_project(project_name)

        if name not in project["clues"]:
            raise KeyError(f"線索 '{name}' 不存在")

        project["clues"][name]["clue_sheet"] = sheet_path
        self.save_project(project_name, project)
        return project

    def get_clue(self, project_name: str, name: str) -> dict:
        """
        獲取線索定義

        Args:
            project_name: 專案名稱
            name: 線索名稱

        Returns:
            線索定義字典
        """
        project = self.load_project(project_name)

        if name not in project["clues"]:
            raise KeyError(f"線索 '{name}' 不存在")

        return project["clues"][name]

    def get_pending_characters(self, project_name: str) -> list[dict]:
        """
        獲取待生成設計圖的角色列表

        Args:
            project_name: 專案名稱

        Returns:
            待處理角色列表（無 character_sheet 或檔案不存在）
        """
        project = self.load_project(project_name)
        project_dir = self.get_project_path(project_name)

        pending = []
        for name, char in project.get("characters", {}).items():
            sheet = char.get("character_sheet")
            if not sheet or not (project_dir / sheet).exists():
                pending.append({"name": name, **char})

        return pending

    def get_pending_clues(self, project_name: str) -> list[dict]:
        """
        獲取待生成設計圖的線索列表

        Args:
            project_name: 專案名稱

        Returns:
            待處理線索列表（importance='major' 且無 clue_sheet）
        """
        project = self.load_project(project_name)
        project_dir = self.get_project_path(project_name)

        pending = []
        for name, clue in project["clues"].items():
            if clue.get("importance") == "major":
                sheet = clue.get("clue_sheet")
                if not sheet or not (project_dir / sheet).exists():
                    pending.append({"name": name, **clue})

        return pending

    def get_clue_path(self, project_name: str, filename: str) -> Path:
        """獲取線索設計圖路徑"""
        return self.get_project_path(project_name) / "clues" / filename

    # ==================== 角色/線索直接寫入工具 ====================

    def add_character(self, project_name: str, name: str, description: str, voice_style: str = "") -> bool:
        """
        直接新增角色到 project.json

        如果角色已存在，跳過不覆蓋。

        Args:
            project_name: 專案名稱
            name: 角色名稱
            description: 角色描述
            voice_style: 聲音風格（可選）

        Returns:
            True 如果新增成功，False 如果已存在
        """
        project = self.load_project(project_name)

        if name in project.get("characters", {}):
            logger.debug("角色 '%s' 已存在於 project.json，跳過", name)
            return False

        if "characters" not in project:
            project["characters"] = {}

        project["characters"][name] = {
            "description": description,
            "character_sheet": "",
            "voice_style": voice_style,
        }

        self.save_project(project_name, project)
        logger.info("新增角色: %s", name)
        return True

    def add_clue(
        self,
        project_name: str,
        name: str,
        clue_type: str,
        description: str,
        importance: str = "minor",
    ) -> bool:
        """
        直接新增線索到 project.json

        如果線索已存在，跳過不覆蓋。

        Args:
            project_name: 專案名稱
            name: 線索名稱
            clue_type: 線索型別（prop 或 location）
            description: 線索描述
            importance: 重要性（major 或 minor，預設 minor）

        Returns:
            True 如果新增成功，False 如果已存在
        """
        project = self.load_project(project_name)

        if name in project.get("clues", {}):
            logger.debug("線索 '%s' 已存在於 project.json，跳過", name)
            return False

        if "clues" not in project:
            project["clues"] = {}

        project["clues"][name] = {
            "type": clue_type,
            "description": description,
            "importance": importance,
            "clue_sheet": "",
        }

        self.save_project(project_name, project)
        logger.info("新增線索: %s", name)
        return True

    def add_characters_batch(self, project_name: str, characters: dict[str, dict]) -> int:
        """
        批次新增角色到 project.json

        Args:
            project_name: 專案名稱
            characters: 角色字典 {name: {description, voice_style}}

        Returns:
            新增的角色數量
        """
        project = self.load_project(project_name)

        if "characters" not in project:
            project["characters"] = {}

        added = 0
        for name, data in characters.items():
            if name not in project["characters"]:
                project["characters"][name] = {
                    "description": data.get("description", ""),
                    "character_sheet": data.get("character_sheet", ""),
                    "voice_style": data.get("voice_style", ""),
                }
                added += 1
                logger.info("新增角色: %s", name)
            else:
                logger.debug("角色 '%s' 已存在，跳過", name)

        if added > 0:
            self.save_project(project_name, project)

        return added

    def add_clues_batch(self, project_name: str, clues: dict[str, dict]) -> int:
        """
        批次新增線索到 project.json

        Args:
            project_name: 專案名稱
            clues: 線索字典 {name: {type, description, importance}}

        Returns:
            新增的線索數量
        """
        project = self.load_project(project_name)

        if "clues" not in project:
            project["clues"] = {}

        added = 0
        for name, data in clues.items():
            if name not in project["clues"]:
                project["clues"][name] = {
                    "type": data.get("type", "prop"),
                    "description": data.get("description", ""),
                    "importance": data.get("importance", "minor"),
                    "clue_sheet": data.get("clue_sheet", ""),
                }
                added += 1
                logger.info("新增線索: %s", name)
            else:
                logger.debug("線索 '%s' 已存在，跳過", name)

        if added > 0:
            self.save_project(project_name, project)

        return added

    # ==================== 參考圖收集工具 ====================

    def collect_reference_images(self, project_name: str, scene: dict) -> list[Path]:
        """
        收集場景所需的所有參考圖

        Args:
            project_name: 專案名稱
            scene: 場景字典

        Returns:
            參考圖路徑列表
        """
        project = self.load_project(project_name)
        project_dir = self.get_project_path(project_name)
        refs = []

        # 角色參考圖
        for char in scene.get("characters_in_scene", []):
            char_data = project["characters"].get(char, {})
            sheet = char_data.get("character_sheet")
            if sheet:
                sheet_path = project_dir / sheet
                if sheet_path.exists():
                    refs.append(sheet_path)

        # 線索參考圖
        for clue in scene.get("clues_in_scene", []):
            clue_data = project["clues"].get(clue, {})
            sheet = clue_data.get("clue_sheet")
            if sheet:
                sheet_path = project_dir / sheet
                if sheet_path.exists():
                    refs.append(sheet_path)

        return refs

    # ==================== 專案概述生成 ====================

    def _read_source_files(self, project_name: str, max_chars: int = 50000) -> str:
        """
        讀取專案 source 目錄下的所有文字檔案內容

        Args:
            project_name: 專案名稱
            max_chars: 最大讀取字元數（避免超出 API 限制）

        Returns:
            合併後的文字內容
        """
        project_dir = self.get_project_path(project_name)
        source_dir = project_dir / "source"

        if not source_dir.exists():
            return ""

        contents = []
        total_chars = 0

        # 按檔名排序，確保順序一致
        for file_path in sorted(source_dir.glob("*")):
            if file_path.is_file() and file_path.suffix.lower() in [".txt", ".md"]:
                try:
                    with open(file_path, encoding="utf-8") as f:
                        content = f.read()
                        remaining = max_chars - total_chars
                        if remaining <= 0:
                            break
                        if len(content) > remaining:
                            content = content[:remaining]
                        contents.append(f"--- {file_path.name} ---\n{content}")
                        total_chars += len(content)
                except Exception as e:
                    logger.error("讀取檔案失敗 %s: %s", file_path.name, e)

        return "\n\n".join(contents)

    async def generate_overview(self, project_name: str) -> dict:
        """
        使用 Gemini API 非同步生成專案概述

        Args:
            project_name: 專案名稱

        Returns:
            生成的 overview 字典，包含 synopsis, genre, theme, world_setting, generated_at
        """
        from .text_backends.base import TextGenerationRequest, TextTaskType
        from .text_generator import TextGenerator

        # 讀取原始檔內容
        source_content = self._read_source_files(project_name)
        if not source_content:
            raise ValueError("source 目錄為空，無法生成概述")

        # 建立 TextGenerator（自動追蹤用量）
        generator = await TextGenerator.create(TextTaskType.OVERVIEW, project_name)

        # 呼叫 TextGenerator（Structured Outputs）
        prompt = f"請分析以下小說內容，提取關鍵資訊：\n\n{source_content}"

        result = await generator.generate(
            TextGenerationRequest(
                prompt=prompt,
                response_schema=ProjectOverview,
            ),
            project_name=project_name,
        )
        response_text = result.text

        # 解析並驗證響應
        overview = ProjectOverview.model_validate_json(response_text)
        overview_dict = overview.model_dump()
        overview_dict["generated_at"] = datetime.now().isoformat()

        # 儲存到 project.json
        project = self.load_project(project_name)
        project["overview"] = overview_dict
        self.save_project(project_name, project)

        logger.info("專案概述已生成並儲存")
        return overview_dict
