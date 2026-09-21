"""AI 分析 & 练习生成 schemas."""

from __future__ import annotations

from pydantic import BaseModel, Field


# ========== 分析请求/响应 ==========
class AnalyzeRequest(BaseModel):
    """图片 (base64 data URL) 分析请求."""

    image_data_url: str = Field(..., description="base64 data URL, 形如 data:image/png;base64,...")
    subject: str | None = None
    grade_semester: str | None = None
    custom_prompt: str | None = None


class AnalyzedQuestion(BaseModel):
    """AI 返回的结构化结果 (对应原 ParsedQuestionSchema)."""

    question_text: str
    answer_text: str | None = None
    analysis: str | None = None
    wrong_answer_text: str | None = None
    mistake_analysis: str | None = None
    mistake_status: str | None = None  # not_attempted / wrong_attempt / unknown
    subject: str | None = None
    knowledge_tags: list[str] = Field(default_factory=list)
    geogebra_commands: list[str] = Field(default_factory=list)
    geogebra_suitable: bool = False


class AnalyzeResponse(BaseModel):
    question: AnalyzedQuestion


# ========== 练习生成 ==========
class PracticeGenerateRequest(BaseModel):
    """从错题生成干扰项 / 练习题."""

    error_item_id: str
    option_count: int = Field(default=4, ge=2, le=6)


class PracticeQuestion(BaseModel):
    """生成的一道练习题."""

    question: str
    options: list[str]
    correct_index: int
    explanations: list[str] = Field(default_factory=list)


# ========== 通用 ==========
class MessageResponse(BaseModel):
    message: str
