"""错题 (ErrorItem) schemas."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class ErrorItemCreate(BaseModel):
    original_image_url: str
    subject_id: str | None = None
    image_storage_key: str | None = None
    image_mime_type: str | None = None
    reference_image_url: str | None = None
    wrong_answer_image_url: str | None = None
    ocr_text: str | None = None
    question_text: str | None = None
    answer_text: str | None = None
    analysis: str | None = None
    wrong_answer_text: str | None = None
    mistake_analysis: str | None = None
    mistake_status: str | None = None
    source: str | None = None
    error_type: str | None = None
    user_notes: str | None = None
    grade_semester: str | None = None
    paper_level: str | None = None
    tag_ids: list[str] = Field(default_factory=list)

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ErrorItemUpdate(BaseModel):
    subject_id: str | None = None
    question_text: str | None = None
    answer_text: str | None = None
    analysis: str | None = None
    wrong_answer_text: str | None = None
    mistake_analysis: str | None = None
    mistake_status: str | None = None
    source: str | None = None
    error_type: str | None = None
    user_notes: str | None = None
    mastery_level: int | None = Field(default=None, ge=0, le=2)
    grade_semester: str | None = None
    paper_level: str | None = None
    tag_ids: list[str] | None = None

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ErrorItemOut(BaseModel):
    id: str
    subject_id: str | None
    subject_name: str | None = None
    original_image_url: str
    reference_image_url: str | None = None
    wrong_answer_image_url: str | None = None
    question_text: str | None = None
    answer_text: str | None = None
    analysis: str | None = None
    wrong_answer_text: str | None = None
    mistake_analysis: str | None = None
    mistake_status: str | None = None
    source: str | None = None
    error_type: str | None = None
    user_notes: str | None = None
    mastery_level: int
    grade_semester: str | None = None
    paper_level: str | None = None
    tags: list[dict] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


class ErrorItemListResponse(BaseModel):
    items: list[ErrorItemOut]
    total: int
    page: int
    page_size: int

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
