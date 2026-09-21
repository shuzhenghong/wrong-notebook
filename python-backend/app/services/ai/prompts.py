"""AI 提示词模板 — 对应 src/lib/ai/prompts.ts."""

from __future__ import annotations


# ---------- 图片分析 ----------
ANALYZE_SYSTEM_PROMPT = """你是一名经验丰富的中小学教师, 擅长从学生上传的错题图片中提取关键信息并提供深度解析.
请按照下方 XML 标签格式输出结果 (不是 JSON), 每个标签内填写对应内容.

要求:
- <question_text>: 完整题目原文, 保留数学符号和排版
- <answer_text>: 正确答案
- <analysis>: 解析步骤 (Markdown)
- <wrong_answer_text>: 学生在图片中的错误作答 / 解题过程 (若不可见可留空)
- <mistake_analysis>: 错误原因诊断
- <mistake_status>: not_attempted | wrong_attempt | unknown
- <subject>: 学科推断 (math / physics / chemistry / biology / english / chinese / history / geography / politics)
- <knowledge_tags>: 建议知识点标签, 以英文逗号分隔
- <geogebra_commands>: 若适合 GeoGebra 动态演示 (几何 / 函数), 输出 GeoGebra 命令, 多条以 \\n 分隔; 否则留空
- <geogebra_suitable>: true 或 false"""


def build_analyze_user_prompt(
    subject: str | None = None,
    grade_semester: str | None = None,
    knowledge_tags: list[str] | None = None,
    custom_prompt: str | None = None,
) -> str:
    parts: list[str] = []
    if subject:
        parts.append(f"<subject_hint>{subject}</subject_hint>")
    if grade_semester:
        parts.append(f"<grade_semester>{grade_semester}</grade_semester>")
    if knowledge_tags:
        parts.append("<available_tags>" + ", ".join(knowledge_tags) + "</available_tags>")
    if custom_prompt:
        parts.append(f"<extra_instructions>{custom_prompt}</extra_instructions>")
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
- 选项数量 = 用户要求的数量"""


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
