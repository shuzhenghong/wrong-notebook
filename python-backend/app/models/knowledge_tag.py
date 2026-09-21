"""KnowledgeTag 模型 — 对应 Prisma KnowledgeTag (无限层级树 + 多学科)."""

from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class KnowledgeTag(Base, TimestampMixin):
    __tablename__ = "knowledge_tags"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    subject: Mapped[str] = mapped_column(String(32), nullable=False, index=True)

    parent_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("knowledge_tags.id", ondelete="SET NULL"), nullable=True, index=True
    )
    order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    code: Mapped[str | None] = mapped_column(String(32), nullable=True)

    is_system: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    user_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )

    # ---- 关系 ----
    parent: Mapped["KnowledgeTag | None"] = relationship(
        remote_side=[id], back_populates="children"
    )
    children: Mapped[list["KnowledgeTag"]] = relationship(back_populates="parent")
    user: Mapped["User | None"] = relationship(back_populates="custom_tags")
    error_items: Mapped[list["ErrorItem"]] = relationship(
        secondary="error_item_tags", back_populates="tags"
    )

    __table_args__ = (
        # 联合唯一: 同一用户/系统下同一父节点的标签名不重复
        # SQLite 对 NULL 的唯一索引处理特殊，此处用 application 层校验 + 尽量约束
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<KnowledgeTag id={self.id} name={self.name} subject={self.subject}>"
