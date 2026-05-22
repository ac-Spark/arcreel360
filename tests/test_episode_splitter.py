import pytest

from lib.episode_splitter import (
    count_chars,
    find_char_offset,
    find_natural_breakpoints,
    peek_split,
    split_episode_text,
)


def test_count_chars_skips_blank_lines():
    text = "abc\n\n  \ndef"
    assert count_chars(text) == 6  # "abc" + "def"，空行與純空白行不計


def test_count_chars_includes_punctuation():
    assert count_chars("你好，世界！") == 6


def test_find_char_offset_basic():
    text = "abcde"
    assert find_char_offset(text, 3) == 2


def test_find_char_offset_skips_blank_line():
    text = "ab\n\ncd"  # 有效字元: a b c d；c 是第 3 個
    # offset: a=0 b=1 \n=2 \n=3 c=4 d=5 → 第 3 個有效字元在 offset 4
    assert find_char_offset(text, 3) == 4


def test_find_char_offset_overflow_returns_end():
    text = "abc"
    assert find_char_offset(text, 999) == len(text)


def test_find_natural_breakpoints_finds_sentence_end():
    text = "他轉身。她跟上。"
    bps = find_natural_breakpoints(text, center_offset=4, window=10)
    assert any(bp["type"] == "sentence" for bp in bps)
    assert bps == sorted(bps, key=lambda b: b["distance"])


def test_find_natural_breakpoints_finds_paragraph():
    text = "第一段。\n\n第二段。"
    bps = find_natural_breakpoints(text, center_offset=len("第一段。\n"), window=10)
    assert any(bp["type"] == "paragraph" for bp in bps)


def test_peek_split_returns_context_and_breakpoints():
    text = "甲" * 10 + "。" + "乙" * 10
    result = peek_split(text, target_chars=10, context=5)
    assert result["total_chars"] == 21
    assert result["target_chars"] == 10
    assert "context_before" in result and "context_after" in result
    assert isinstance(result["nearby_breakpoints"], list)


def test_peek_split_target_overflow_raises():
    with pytest.raises(ValueError, match="超過"):
        peek_split("短文", target_chars=100)


def test_split_episode_text_basic():
    text = "前半段落。他轉身離開了。後半段落。"
    result = split_episode_text(text, target_chars=8, anchor="他轉身離開了。", context=20)
    assert result["part_before"].endswith("他轉身離開了。")
    assert result["part_after"].startswith("後半段落。")
    assert result["split_pos"] == len("前半段落。他轉身離開了。")
    assert result["before_preview"] in result["part_before"]


def test_split_episode_text_anchor_not_found_raises():
    with pytest.raises(ValueError, match="未找到錨點"):
        split_episode_text("一些文字內容。", target_chars=3, anchor="不存在的錨點", context=50)


def test_split_episode_text_anchor_multiple_picks_nearest():
    text = "錨點AB" + "X" * 20 + "錨點AB" + "Y" * 5
    target_offset_chars = len("錨點AB") + 20 + 1  # 接近第二個錨點
    result = split_episode_text(text, target_chars=target_offset_chars, anchor="錨點AB", context=30)
    assert result["split_pos"] == len("錨點AB") + 20 + len("錨點AB")
    assert result["anchor_match_count"] == 2


def test_split_into_n_episodes_single():
    """N=1：整本即唯一一集。"""
    from lib.episode_splitter import split_into_n_episodes

    text = "第一句。第二句。第三句。"
    parts = split_into_n_episodes(text, 1)
    assert parts == [text]


def test_split_into_n_episodes_two_parts_concatenate_to_original():
    """N=2：兩段串接後等於原文（不丟字、不重複）。"""
    from lib.episode_splitter import split_into_n_episodes

    text = "甲" * 50 + "。" + "乙" * 50 + "。"
    parts = split_into_n_episodes(text, 2)
    assert len(parts) == 2
    assert "".join(parts) == text
    assert min(len(p) for p in parts) >= len(text) // 4


def test_split_into_n_episodes_cuts_on_sentence_end():
    """切點應落在句末標點之後，不切斷句子。"""
    from lib.episode_splitter import split_into_n_episodes

    text = "甲甲甲甲甲。乙乙乙乙乙。丙丙丙丙丙。"
    parts = split_into_n_episodes(text, 3)
    assert len(parts) == 3
    assert "".join(parts) == text
    for part in parts[:-1]:
        assert part.rstrip()[-1] in "。！？…"


def test_split_into_n_episodes_three_parts():
    """N=3：產生 3 段，串接還原。"""
    from lib.episode_splitter import split_into_n_episodes

    text = "".join(f"這是第{i}句話。" for i in range(30))
    parts = split_into_n_episodes(text, 3)
    assert len(parts) == 3
    assert "".join(parts) == text


def test_split_into_n_episodes_invalid_n_raises():
    """N<1 → ValueError。"""
    import pytest

    from lib.episode_splitter import split_into_n_episodes

    with pytest.raises(ValueError):
        split_into_n_episodes("一些文字。", 0)


def test_split_into_n_episodes_more_episodes_than_content():
    """N 大於可切分句子數：仍回傳 N 段，允許部分段為空字串，串接仍還原。"""
    from lib.episode_splitter import split_into_n_episodes

    text = "只有一句。"
    parts = split_into_n_episodes(text, 5)
    assert len(parts) == 5
    assert "".join(parts) == text
