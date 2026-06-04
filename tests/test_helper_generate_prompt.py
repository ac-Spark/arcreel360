def test_helper_system_prompt_traditional_chinese():
    from server.routers.generate import _build_helper_system_prompt

    for is_video in (True, False):
        sp = _build_helper_system_prompt(is_video)
        assert "繁體中文" in sp
        assert "英文 Prompt" not in sp
        assert "Zoom in" not in sp  # 相機運動範例已中文化
