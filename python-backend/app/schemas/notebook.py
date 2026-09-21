"""错题本 (Subject) & 知识点标签 schemas."""

from __future__ import annotations

from pydantic import BaseModel


# ========== Subject ==========
class SubjectCreate(BaseModel):
    name: str


class SubjectUpdate(BaseModel):
    name: str


class SubjectOut(BaseModel):
    id: str
    name: str
    error_count: int = 0

    model_config = {"from_attributes": True}


# ========== KnowledgeTag ==========
class KnowledgeTagCreate(BaseModel):
    name: str
    subject: str
    parent_id: str | None = None
    code: str | None = None
    order: int = 0


class KnowledgeTagUpdate(BaseModel):
    name: str | None = None
    parent_id: str | None = None
    order: int | None = None
    code: str | None = None


class KnowledgeTagOut(BaseModel):
    id: str
    name: str
    subject: str
    parent_id: str | None
    code: str | None
    order: int
    is_system: bool
    children: list["KnowledgeTagOut"] = []

    model_config = {"from_attributes": True}


KnowledgeTagOut.model_rebuild()
