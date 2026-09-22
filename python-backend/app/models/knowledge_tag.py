"""KnowledgeTag — Prisma KnowledgeTag."""
from datetime import datetime
from ..utils.timeutil import utc_now
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .base import Base

class KnowledgeTag(Base):
    __tablename__ = "KnowledgeTag"
    id: Mapped[str] = mapped_column("id", String(32), primary_key=True)
    name: Mapped[str] = mapped_column("name", String(128), nullable=False)
    subject: Mapped[str] = mapped_column("subject", String(32), nullable=False)
    parent_id: Mapped[str | None] = mapped_column("parentId", ForeignKey("KnowledgeTag.id", ondelete="SET NULL"), nullable=True)
    order: Mapped[int] = mapped_column("order", Integer, default=0, nullable=False)
    code: Mapped[str | None] = mapped_column("code", String(32), nullable=True)
    is_system: Mapped[bool] = mapped_column("isSystem", Boolean, default=False, nullable=False)
    user_id: Mapped[str | None] = mapped_column("userId", ForeignKey("User.id", ondelete="CASCADE"), nullable=True)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    parent: Mapped["KnowledgeTag | None"] = relationship(remote_side=[id], back_populates="children")
    children: Mapped[list["KnowledgeTag"]] = relationship(back_populates="parent")
    user: Mapped["User | None"] = relationship(back_populates="custom_tags")
    error_items: Mapped[list["ErrorItem"]] = relationship(secondary="_ErrorItemToKnowledgeTag", back_populates="tags")
