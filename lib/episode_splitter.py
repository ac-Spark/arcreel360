"""分集切分核心：純文字運算（無 I/O、無 cwd 假設）。

供三條路徑共用：
- Claude CLI 腳本（agent_runtime_profile/.claude/skills/manage-project/scripts/*.py，薄 wrapper）
- gemini/openai function handler（server/agent_runtime/skill_function_declarations.py）
- HTTP API（server/routers/projects.py）

計數規則：含標點，不含空行（純空白行不計入字數）。
"""

from __future__ import annotations


def count_chars(text: str) -> int:
    """計算有效字數：所有非空行中的字元總數（含標點，不含空行）。"""
    total = 0
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped:  # 跳過空行
            total += len(stripped)
    return total


def find_char_offset(text: str, target_count: int) -> int:
    """將有效字數轉換為原文字元偏移位置（0-based）。

    遍歷原文，跳過空行中的字元，當累計有效字數達到 target_count 時，
    返回對應的原文字元偏移。target_count 超過總有效字數時，返回文字末尾偏移。
    """
    counted = 0
    lines = text.split("\n")
    pos = 0  # 原文中的字元位置

    for line_idx, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            # 空行：跳過整行（含換行符）
            pos += len(line)
            if line_idx < len(lines) - 1:
                pos += 1  # 換行符
            continue

        # 非空行：逐字元計數
        for char in line:
            if not char.strip():
                # 行首/行尾空白不計入有效字數，但推進偏移
                pos += 1
                continue
            counted += 1
            if counted >= target_count:
                return pos
            pos += 1

        if line_idx < len(lines) - 1:
            pos += 1  # 換行符

    return pos


def find_natural_breakpoints(text: str, center_offset: int, window: int = 200) -> list[dict]:
    """在指定偏移附近查詢自然斷點（句末標點、段落邊界）。

    回斷點列表，每個斷點含：
    - offset: 原文字元偏移（標點/段落之後的位置）
    - char: 斷點字元
    - type: 斷點型別（sentence / paragraph）
    - distance: 距 center_offset 的字元數

    結果按 distance 由近到遠排序。
    """
    start = max(0, center_offset - window)
    end = min(len(text), center_offset + window)

    sentence_endings = {"。", "！", "？", "…"}
    breakpoints: list[dict] = []

    for i in range(start, end):
        ch = text[i]
        if ch == "\n" and i + 1 < len(text) and text[i + 1] == "\n":
            breakpoints.append(
                {
                    "offset": i + 1,
                    "char": "\\n\\n",
                    "type": "paragraph",
                    "distance": abs(i + 1 - center_offset),
                }
            )
        elif ch in sentence_endings:
            breakpoints.append(
                {
                    "offset": i + 1,  # 在標點之後切分
                    "char": ch,
                    "type": "sentence",
                    "distance": abs(i + 1 - center_offset),
                }
            )

    breakpoints.sort(key=lambda bp: bp["distance"])
    return breakpoints


def find_anchor_near_target(text: str, anchor: str, target_offset: int, window: int = 500) -> list[int]:
    """在 target_offset 附近視窗內查 anchor，回匹配「末尾」偏移列表（按距 target_offset 排序）。"""
    search_start = max(0, target_offset - window)
    search_end = min(len(text), target_offset + window)
    region = text[search_start:search_end]
    positions: list[int] = []
    start = 0
    while True:
        idx = region.find(anchor, start)
        if idx == -1:
            break
        positions.append(search_start + idx + len(anchor))  # 錨點末尾的絕對偏移
        start = idx + 1
    positions.sort(key=lambda p: abs(p - target_offset))
    return positions


def peek_split(source_text: str, target_chars: int, context: int = 200) -> dict:
    """預覽分集切分點（read-only）。

    Args:
        source_text: 小說原文。
        target_chars: 目標有效字數（含標點、不含空行）。
        context: 前後文與斷點搜尋視窗（字元數）。

    Returns:
        {total_chars, target_chars, target_offset, context_before, context_after, nearby_breakpoints}。
        （key 名與既有 peek_split_point.py 的 JSON 輸出一致，但不含 'source'。）

    Raises:
        ValueError: target_chars 大於等於總有效字數。
    """
    total_chars = count_chars(source_text)
    if target_chars >= total_chars:
        raise ValueError(f"目標字數 ({target_chars}) 超過或等於總有效字數 ({total_chars})")
    target_offset = find_char_offset(source_text, target_chars)
    breakpoints = find_natural_breakpoints(source_text, target_offset, window=context)
    ctx_start = max(0, target_offset - context)
    ctx_end = min(len(source_text), target_offset + context)
    return {
        "total_chars": total_chars,
        "target_chars": target_chars,
        "target_offset": target_offset,
        "context_before": source_text[ctx_start:target_offset],
        "context_after": source_text[target_offset:ctx_end],
        "nearby_breakpoints": breakpoints[:10],
    }


def split_episode_text(source_text: str, target_chars: int, anchor: str, context: int = 500) -> dict:
    """用 anchor 在 target_chars 附近精確定位切點，回兩半文字。

    anchor 找不到 → ValueError。anchor 多個 → 選距 target 最近的（不報錯，回傳 anchor_match_count 供呼叫方提示）。

    Returns:
        {split_pos, part_before, part_after, before_preview, after_preview, anchor_match_count, target_offset}。
    """
    target_offset = find_char_offset(source_text, target_chars)
    positions = find_anchor_near_target(source_text, anchor, target_offset, window=context)
    if not positions:
        raise ValueError(f'在目標字數 {target_chars} 附近（±{context} 字元視窗）未找到錨點文字: "{anchor}"')
    split_pos = positions[0]
    part_before = source_text[:split_pos]
    part_after = source_text[split_pos:]
    preview_len = 50
    return {
        "split_pos": split_pos,
        "part_before": part_before,
        "part_after": part_after,
        "before_preview": part_before[-preview_len:] if len(part_before) > preview_len else part_before,
        "after_preview": part_after[:preview_len] if len(part_after) > preview_len else part_after,
        "anchor_match_count": len(positions),
        "target_offset": target_offset,
    }
