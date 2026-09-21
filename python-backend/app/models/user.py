"""User 模型 — 对应 Prisma User."""

from __future__ import annotations

from sqlalchemy import Boolean, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    education_stage: Mapped[str | None] = mapped_column(String(32), nullable=True)
    enrollment_year: Mapped[int | None] = mapped_column(Integer, nullable=True)

    role: Mapped[str] = mapped_column(String(16), default="user", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # ---- 关系 ----
    subjects: Mapped[list["Subject"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    error_items: Mapped[list["ErrorItem"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    practice_records: Mapped[list["PracticeRecord"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    custom_tags: Mapped[list["KnowledgeTag"]] = relationship(back_populates="user", cascade="all, delete-orphan")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<User id={self.id} email={self.email} role={self.role}>"
