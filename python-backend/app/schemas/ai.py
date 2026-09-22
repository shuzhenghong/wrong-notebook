"""AI 分析 & 练习生成 schemas."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


# ========== 分析请求/响应 ==========
class AnalyzeRequest(BaseModel):
    image_data_url: str = Field(..., description="base64 data URL")
    subject: str | None = None
    grade_semester: str | None = None
    custom_prompt: str | None = None

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class AnalyzedQuestion(BaseModel):
    question_text: str
    answer_text: str | None = None
    analysis: str | None = None
    wrong_answer_text: str | None = None
    mistake_analysis: str | None = None
    mistake_status: str | None = None
    subject: str | None = None
    knowledge_tags: list[str] = Field(default_factory=list)
    geogebra_commands: list[str] = Field(default_factory=list)
    geogebra_suitable: bool = False

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class AnalyzeResponse(BaseModel):
    question: AnalyzedQuestion


# ========== 练习生成 ==========
class PracticeGenerateRequest(BaseModel):
    error_item_id: str
    option_count: int = Field(default=4, ge=2, le=6)

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class PracticeQuestion(BaseModel):
    question: str
    options: list[str]
    correct_index: int
    explanations: list[str] = Field(default_factory=list)

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ========== 通用 ==========
class MessageResponse(BaseModel):
    message: str
