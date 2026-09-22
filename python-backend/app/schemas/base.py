"""统一基类 — 所有 Pydantic schema 的根."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """对外 API schema — 输出 camelCase, 输入兼容两种命名."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
    )


class SnakeModel(BaseModel):
    """内部/Next.js 兼容 schema — 保持 snake_case (可选)."""

    model_config = ConfigDict(from_attributes=True)
