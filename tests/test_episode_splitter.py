from lib.episode_splitter import count_chars, find_char_offset, find_natural_breakpoints


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
