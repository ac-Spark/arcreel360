"""
prompt_builders_script.py - 劇本生成 Prompt 構建器

1. XML 標籤分隔上下文
2. 明確的欄位描述和約束
3. 可選值列表約束輸出
"""


def _format_character_names(characters: dict) -> str:
    """格式化角色列表（含描述，協助 LLM 正確識別）"""
    lines = []
    for name, data in characters.items():
        desc = (data.get("description") or "").strip() if isinstance(data, dict) else ""
        if desc:
            lines.append(f"- **{name}**：{desc}")
        else:
            lines.append(f"- **{name}**")
    return "\n".join(lines)


def _format_clue_names(clues: dict) -> str:
    """格式化線索列表（含類型與描述，協助 LLM 正確識別）"""
    type_label = {"prop": "道具", "location": "場景"}
    lines = []
    for name, data in clues.items():
        if not isinstance(data, dict):
            lines.append(f"- **{name}**")
            continue
        desc = (data.get("description") or "").strip()
        ctype = data.get("clue_type")
        head = f"- **{name}**"
        if ctype in type_label:
            head += f"（{type_label[ctype]}）"
        if desc:
            lines.append(f"{head}：{desc}")
        else:
            lines.append(head)
    return "\n".join(lines)


def _format_duration_constraint(supported_durations: list[int], default_duration: int | None) -> str:
    """根據引數生成時長約束描述。"""
    durations_str = ", ".join(str(d) for d in supported_durations)
    if default_duration is not None:
        return f"時長：從 [{durations_str}] 秒中選擇，預設使用 {default_duration} 秒"
    return f"時長：從 [{durations_str}] 秒中選擇，根據內容節奏自行決定"


def _format_aspect_ratio_desc(aspect_ratio: str) -> str:
    """根據寬高比返回構圖描述。"""
    if aspect_ratio == "9:16":
        return "豎屏構圖"
    elif aspect_ratio == "16:9":
        return "橫屏構圖"
    return f"{aspect_ratio} 構圖"


def build_narration_prompt(
    project_overview: dict,
    style: str,
    style_description: str,
    characters: dict,
    clues: dict,
    segments_md: str,
    supported_durations: list[int] | None = None,
    default_duration: int | None = None,
    aspect_ratio: str = "9:16",
) -> str:
    """
    構建說書模式的 Prompt

    Args:
        project_overview: 專案概述（synopsis, genre, theme, world_setting）
        style: 視覺風格標籤
        style_description: 風格描述
        characters: 角色字典（僅用於提取名稱列表）
        clues: 線索字典（僅用於提取名稱列表）
        segments_md: Step 1 的 Markdown 內容

    Returns:
        構建好的 Prompt 字串
    """
    character_names = list(characters.keys())
    clue_names = list(clues.keys())

    prompt = f"""你的任務是為短影片生成分鏡劇本。請仔細遵循以下指示：

**重要：所有輸出內容必須使用中文。僅 JSON 鍵名和列舉值使用英文。**

1. 你將獲得故事概述、視覺風格、角色列表、線索列表，以及已拆分的小說片段。

2. 為每個片段生成：
   - image_prompt：第一幀的影象生成提示詞（中文描述）
   - video_prompt：動作和音效的影片生成提示詞（中文描述）

<overview>
{project_overview.get("synopsis", "")}

題材型別：{project_overview.get("genre", "")}
核心主題：{project_overview.get("theme", "")}
世界觀設定：{project_overview.get("world_setting", "")}
</overview>

<style>
風格：{style}
描述：{style_description}
</style>

<characters>
{_format_character_names(characters)}
</characters>

<clues>
{_format_clue_names(clues)}
</clues>

<segments>
{segments_md}
</segments>

segments 為片段拆分表，每行是一個片段，包含：
- 片段 ID：格式為 E{{集數}}S{{序號}}
- 小說原文：必須原樣保留到 novel_text 欄位
- {_format_duration_constraint(supported_durations or [4, 6, 8], default_duration)}
- 是否有對話：用於判斷是否需要填寫 video_prompt.dialogue
- 是否為 segment_break：場景切換點，需設定 segment_break 為 true

3. 為每個片段生成時，遵循以下規則：

a. **novel_text**：原樣複製小說原文，不做任何修改。

b. **characters_in_segment**：列出本片段中實際出場的角色名稱。
   - 可選值：[{", ".join(character_names)}]
   - 必須**忠實對照** characters 區塊的描述，根據小說正文判斷實際出場者；不要因為列表第一項就盲目選用。
   - 若小說正文使用代稱、別名或第三人稱，仍應對照描述歸位到對應角色。
   - 若片段無任何已定義角色出場（如純風景描述），填空陣列 []。

c. **clues_in_segment**：列出本片段中可見或被提及的線索名稱（道具與場景）。
   - 可選值：[{", ".join(clue_names)}]
   - 必須**忠實標註**：只要小說正文的描寫匹配 clues 區塊中某個線索的描述（包含別稱、外觀特徵、所在地點），就要列入。
   - 「道具」類線索若在畫面中可見，務必填入，後續會作為視覺參考圖；遺漏會導致影像生成時道具走樣。
   - 「場景」類線索若是該片段發生地，也要填入。
   - 若片段確實未涉及任何已定義線索，填空陣列 []。

d. **image_prompt**：生成包含以下欄位的物件：
   - scene：用中文描述此刻畫面中的具體場景——角色位置、姿態、表情、服裝細節，以及可見的環境元素和物品。
     聚焦當下瞬間的可見畫面。僅描述攝像機能夠捕捉到的具體視覺元素。
     確保描述避免超出此刻畫面的元素。排除比喻、隱喻、抽象情緒詞、主觀評價、多場景切換等無法直接渲染的描述。
     畫面應自包含，不暗示過去事件或未來發展。
   - composition：
     - shot_type：鏡頭型別（Extreme Close-up, Close-up, Medium Close-up, Medium Shot, Medium Long Shot, Long Shot, Extreme Long Shot, Over-the-shoulder, Point-of-view）
     - lighting：用中文描述具體的光源型別、方向和色溫（如"左側窗戶透入的暖黃色晨光"）
     - ambiance：用中文描述可見的環境效果（如"薄霧瀰漫"、"塵埃飛揚"），避免抽象情緒詞

e. **video_prompt**：生成包含以下欄位的物件：
   - action：用中文精確描述該時長內主體的具體動作——身體移動、手勢變化、表情轉換。
     聚焦單一連貫動作，確保在指定時長內可完成。
     排除多場景切換、蒙太奇、快速剪輯等單次生成無法實現的效果。
     排除比喻性動作描述（如"像蝴蝶般飛舞"）。
   - camera_motion：鏡頭運動（Static, Pan Left, Pan Right, Tilt Up, Tilt Down, Zoom In, Zoom Out, Tracking Shot）
     每個片段僅選擇一種鏡頭運動。
   - ambiance_audio：用中文描述畫內音（diegetic sound）——環境聲、腳步聲、物體聲音。
     僅描述場景內真實存在的聲音。排除音樂、BGM、旁白、畫外音。
   - dialogue：{{speaker, line}} 陣列。僅當原文有引號對話時填寫。speaker 必須來自 characters_in_segment。

f. **segment_break**：如果在片段表中標記為"是"，則設為 true。

g. **duration_seconds**：使用片段表中的時長。

h. **transition_to_next**：預設為 "cut"。

目標：建立生動、視覺一致的分鏡提示詞，用於指導 AI 影象和影片生成。保持創意、具體，並忠於原文。
"""
    return prompt


def build_drama_prompt(
    project_overview: dict,
    style: str,
    style_description: str,
    characters: dict,
    clues: dict,
    scenes_md: str,
    supported_durations: list[int] | None = None,
    default_duration: int | None = None,
    aspect_ratio: str = "16:9",
) -> str:
    """
    構建劇集動畫模式的 Prompt

    Args:
        project_overview: 專案概述
        style: 視覺風格標籤
        style_description: 風格描述
        characters: 角色字典
        clues: 線索字典
        scenes_md: Step 1 的 Markdown 內容

    Returns:
        構建好的 Prompt 字串
    """
    character_names = list(characters.keys())
    clue_names = list(clues.keys())

    prompt = f"""你的任務是為劇集動畫生成分鏡劇本。請仔細遵循以下指示：

**重要：所有輸出內容必須使用中文。僅 JSON 鍵名和列舉值使用英文。**

1. 你將獲得故事概述、視覺風格、角色列表、線索列表，以及已拆分的場景列表。

2. 為每個場景生成：
   - image_prompt：第一幀的影象生成提示詞（中文描述）
   - video_prompt：動作和音效的影片生成提示詞（中文描述）

<overview>
{project_overview.get("synopsis", "")}

題材型別：{project_overview.get("genre", "")}
核心主題：{project_overview.get("theme", "")}
世界觀設定：{project_overview.get("world_setting", "")}
</overview>

<style>
風格：{style}
描述：{style_description}
</style>

<characters>
{_format_character_names(characters)}
</characters>

<clues>
{_format_clue_names(clues)}
</clues>

<scenes>
{scenes_md}
</scenes>

scenes 為場景拆分表，每行是一個場景，包含：
- 場景 ID：格式為 E{{集數}}S{{序號}}
- 場景描述：劇本改編後的場景內容
- {_format_duration_constraint(supported_durations or [4, 6, 8], default_duration)}
- 場景型別：劇情、動作、對話等
- 是否為 segment_break：場景切換點，需設定 segment_break 為 true

3. 為每個場景生成時，遵循以下規則：

a. **characters_in_scene**：列出本場景中實際出場的角色名稱。
   - 可選值：[{", ".join(character_names)}]
   - 必須**忠實對照** characters 區塊的描述，根據場景內容判斷實際出場者；不要因為列表第一項就盲目選用。
   - 若場景使用代稱、別名或第三人稱，仍應對照描述歸位到對應角色。
   - 若場景無任何已定義角色出場，填空陣列 []。

b. **clues_in_scene**：列出本場景中可見或被提及的線索名稱（道具與場景）。
   - 可選值：[{", ".join(clue_names)}]
   - 必須**忠實標註**：只要場景描寫匹配 clues 區塊中某個線索的描述（包含別稱、外觀特徵、所在地點），就要列入。
   - 「道具」類線索若在畫面中可見，務必填入，後續會作為視覺參考圖；遺漏會導致影像生成時道具走樣。
   - 「場景」類線索若是該場景發生地，也要填入。
   - 若場景確實未涉及任何已定義線索，填空陣列 []。

c. **image_prompt**：生成包含以下欄位的物件：
   - scene：用中文描述此刻畫面中的具體場景——角色位置、姿態、表情、服裝細節，以及可見的環境元素和物品。{_format_aspect_ratio_desc(aspect_ratio)}。
     聚焦當下瞬間的可見畫面。僅描述攝像機能夠捕捉到的具體視覺元素。
     確保描述避免超出此刻畫面的元素。排除比喻、隱喻、抽象情緒詞、主觀評價、多場景切換等無法直接渲染的描述。
     畫面應自包含，不暗示過去事件或未來發展。
   - composition：
     - shot_type：鏡頭型別（Extreme Close-up, Close-up, Medium Close-up, Medium Shot, Medium Long Shot, Long Shot, Extreme Long Shot, Over-the-shoulder, Point-of-view）
     - lighting：用中文描述具體的光源型別、方向和色溫（如"左側窗戶透入的暖黃色晨光"）
     - ambiance：用中文描述可見的環境效果（如"薄霧瀰漫"、"塵埃飛揚"），避免抽象情緒詞

d. **video_prompt**：生成包含以下欄位的物件：
   - action：用中文精確描述該時長內主體的具體動作——身體移動、手勢變化、表情轉換。
     聚焦單一連貫動作，確保在指定時長內可完成。
     排除多場景切換、蒙太奇、快速剪輯等單次生成無法實現的效果。
     排除比喻性動作描述（如"像蝴蝶般飛舞"）。
   - camera_motion：鏡頭運動（Static, Pan Left, Pan Right, Tilt Up, Tilt Down, Zoom In, Zoom Out, Tracking Shot）
     每個片段僅選擇一種鏡頭運動。
   - ambiance_audio：用中文描述畫內音（diegetic sound）——環境聲、腳步聲、物體聲音。
     僅描述場景內真實存在的聲音。排除音樂、BGM、旁白、畫外音。
   - dialogue：{{speaker, line}} 陣列。包含角色對話。speaker 必須來自 characters_in_scene。

e. **segment_break**：如果在場景表中標記為"是"，則設為 true。

f. **duration_seconds**：使用場景表中的時長。

g. **scene_type**：使用場景表中的場景型別，預設為"劇情"。

h. **transition_to_next**：預設為 "cut"。

目標：建立生動、視覺一致的分鏡提示詞，用於指導 AI 影象和影片生成。保持創意、具體，適合{_format_aspect_ratio_desc(aspect_ratio)}動畫呈現。
"""
    return prompt
