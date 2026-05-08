"""
_text_utils.py - 分集切分共享工具函式

提供字數計數和字元偏移轉換功能，供 peek_split_point.py 和 split_episode.py 共享。

計數規則：含標點，不含空行（純空白行不計入字數）。
"""


def count_chars(text: str) -> int:
    """計算有效字數：所有非空行中的字元總數（含標點，不含空行）。"""
    total = 0
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped:  # 跳過空行
            total += len(stripped)
    return total


def find_char_offset(text: str, target_count: int) -> int:
    """將有效字數轉換為原文字元偏移位置。

    遍歷原文，跳過空行中的字元，當累計有效字數達到 target_count 時，
    返回對應的原文字元偏移（0-based）。

    如果 target_count 超過總有效字數，返回文字末尾偏移。
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
        for char_idx, char in enumerate(line):
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
    """在指定偏移附近查詢自然斷點（句號、段落邊界等）。

    返回斷點列表，每個斷點包含：
    - offset: 原文字元偏移
    - char: 斷點字元
    - type: 斷點型別（sentence/paragraph）
    - distance: 距離 center_offset 的字元數
    """
    start = max(0, center_offset - window)
    end = min(len(text), center_offset + window)

    sentence_endings = {"。", "！", "？", "…"}
    breakpoints = []

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

    # 按距離排序
    breakpoints.sort(key=lambda bp: bp["distance"])
    return breakpoints
