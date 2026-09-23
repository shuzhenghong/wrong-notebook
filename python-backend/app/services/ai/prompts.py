"""AI 提示词模板 — 对应 src/lib/ai/prompts.ts.

成本设计说明:
  1. GeoGebra 段落只在可能用到的学科 (数学 / 物理) 才拼进 system prompt.
     英语/历史这类题目永远不会有 GeoGebra 演示, 每次都索要这两行输出纯属浪费
     (输出 token 通常比输入贵数倍), 还会诱导模型凭空编造命令.
  2. analysis / mistake_analysis 给了字数上限 —— 输出长度是真实成本项,
     不设上限时模型倾向写成长篇, 而这些内容用户其实很少读完.
  3. 纯文本模式 (见 build_analyze_system_prompt 的 text_only) 不发送图片,
     图片 token 归零, 是成本优化里幅度最大的一项.
"""

from __future__ import annotations

# 可能用到 GeoGebra 动态演示的学科（含中英文写法）
_GEOGEBRA_SUBJECTS = ("math", "physics", "数学", "物理")


def subject_supports_geogebra(subject: str | None) -> bool:
    """该学科是否需要 GeoGebra 命令输出.

    学科未知时返回 True —— 宁可持续多要两行, 也不能因为拿不准学科
    而漏掉几何题的作图命令（正确性优先于省钱）.
    """
    if not subject:
        return True
    s = subject.strip().lower()
    return any(k in s for k in _GEOGEBRA_SUBJECTS)


# ---------- 图片/文本分析 ----------
_ANALYZE_SYSTEM_HEAD = """你是一名经验丰富的中小学教师, 擅长从学生上传的错题中提取关键信息并提供深度解析.
请按照下方 XML 标签格式输出结果 (不是 JSON), 每个标签内填写对应内容.

要求:
- <question_text>: 完整题目原文, 保留数学符号和排版
- <answer_text>: 正确答案
- <analysis>: 解析步骤 (Markdown, 简明分步, 不超过 300 字)
- <wrong_answer_text>: 学生在图片中的错误作答 / 解题过程 (若不可见可留空)
- <mistake_analysis>: 错误原因诊断 (不超过 120 字)
- <mistake_status>: not_attempted | wrong_attempt | unknown
- <subject>: 学科推断 (math / physics / chemistry / biology / english / chinese / history / geography / politics)
- <knowledge_tags>: 建议知识点标签, 以英文逗号分隔 (3-6 个)"""

_ANALYZE_GEOGEBRA_SECTION = """- <geogebra_commands>: 若适合 GeoGebra 动态演示 (几何 / 函数), 输出 GeoGebra 命令, 多条以 \\n 分隔; 否则留空
- <geogebra_suitable>: true 或 false"""

_ANALYZE_TEXT_ONLY_SECTION = """
本次请求只提供学生端本地 OCR 得到的题目文字, 没有图片.
- 以 <ocr_text> 为准, OCR 的换行错乱 / 符号误识别请按语义自行还原
- 若题目依赖图形、图表或几何关系, 而文字确实无法判断, 在 <analysis> 末尾另起一行注明"本条需结合原图确认"
- 不要因为缺少图片而拒答、输出占位符或索要图片"""


def build_analyze_system_prompt(
    *,
    include_geogebra: bool = True,
    text_only: bool = False,
) -> str:
    """按学科 / 输入形态拼装 system prompt（条件化拼装以省输出 token）."""
    parts = [_ANALYZE_SYSTEM_HEAD]
    if include_geogebra:
        parts.append(_ANALYZE_GEOGEBRA_SECTION)
    prompt = "\n".join(parts)
    if text_only:
        prompt += "\n" + _ANALYZE_TEXT_ONLY_SECTION
    return prompt


# 向后兼容: 完整版（含 GeoGebra 段落、含图片语境）
ANALYZE_SYSTEM_PROMPT = build_analyze_system_prompt()


def build_analyze_user_prompt(
    subject: str | None = None,
    grade_semester: str | None = None,
    knowledge_tags: list[str] | None = None,
    custom_prompt: str | None = None,
    ocr_text: str | None = None,
) -> str:
    """拼装 user prompt.

    传 ocr_text 即表示走纯文本模式: 题目文字直接内联进 prompt, 不再附带图片.
    """
    parts: list[str] = []
    if subject:
        parts.append(f"<subject_hint>{subject}</subject_hint>")
    if grade_semester:
        parts.append(f"<grade_semester>{grade_semester}</grade_semester>")
    if knowledge_tags:
        parts.append("<available_tags>" + ", ".join(knowledge_tags) + "</available_tags>")
    if custom_prompt:
        parts.append(f"<extra_instructions>{custom_prompt}</extra_instructions>")
    if ocr_text:
        parts.append(f"<ocr_text>\n{ocr_text}\n</ocr_text>")
        parts.append("请基于上面的题目文字完成分析.")
    else:
        parts.append("请分析这道题目.")
    return "\n".join(parts)


# ---------- 练习生成 ----------
PRACTICE_SYSTEM_PROMPT = """你是一名资深题库出题专家. 基于给定的原题, 生成一道单项选择题用于能力测试/错题再练.

输出格式 (XML):
<option_1>A 选项内容</option_1>
<option_2>B 选项内容</option_2>
...
<correct_index>正确答案下标 (从 1 开始)</correct_index>
<option_1_explain>为什么对/错</option_1_explain>
...

要求:
- 干扰项应具备迷惑性, 常见易错点
- 覆盖原题核心考点
- 选项数量 = 用户要求的数量
- 每项解析一句话以内"""


def build_practice_user_prompt(
    question_text: str,
    answer_text: str | None,
    analysis: str | None,
    subject: str | None,
    option_count: int,
) -> str:
    lines = [f"<option_count>{option_count}</option_count>"]
    if subject:
        lines.append(f"<subject>{subject}</subject>")
    lines.append(f"<question>{question_text}</question>")
    if answer_text:
        lines.append(f"<correct_answer>{answer_text}</correct_answer>")
    if analysis:
        lines.append(f"<analysis>{analysis}</analysis>")
    lines.append("请生成题目.")
    return "\n".join(lines)
