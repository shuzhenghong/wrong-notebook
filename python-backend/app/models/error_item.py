"""ErrorItem / Subject / ReviewSchedule / PracticeRecord 模型."""

from __future__ import annotations

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    Table,
    Text,
    Boolean,
    Column,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


# ========== 错题 ↔ 知识点多对多中间表 ==========
error_item_tags = Table(
    "error_item_tags",
    Base.metadata,
    Column("error_item_id", String(32), ForeignKey("error_items.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", String(32), ForeignKey("knowledge_tags.id", ondelete="CASCADE"), primary_key=True),
)


# ========== Subject (错题本) ==========
class Subject(Base, TimestampMixin):
    __tablename__ = "subjects"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    user_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    user: Mapped["User"] = relationship(back_populates="subjects")
    error_items: Mapped[list["ErrorItem"]] = relationship(back_populates="subject")

    __table_args__ = (
        # (name, user_id) 联合唯一由 application 层保证
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Subject id={self.id} name={self.name}>"


# ========== ErrorItem (错题) ==========
class ErrorItem(Base, TimestampMixin):
    __tablename__ = "error_items"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    subject_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("subjects.id", ondelete="CASCADE"), nullable=True, index=True
    )

    # 图片
    original_image_url: Mapped[str] = mapped_column(Text, nullable=False)
    image_storage_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    image_mime_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reference_image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    wrong_answer_image_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    # OCR
    ocr_text: Mapped[str | None] = mapped_column(Text, nullable=True)

    # AI 分析结果
    question_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    answer_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    analysis: Mapped[str | None] = mapped_column(Text, nullable=True)
    wrong_answer_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    mistake_analysis: Mapped[str | None] = mapped_column(Text, nullable=True)
    mistake_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    knowledge_points: Mapped[str | None] = mapped_column(Text, nullable=True)  # deprecated JSON
    geogebra_commands: Mapped[str | None] = mapped_column(Text, nullable=True)
    geogebra_suitable: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    # 用户补充
    source: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    mastery_level: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    grade_semester: Mapped[str | None] = mapped_column(String(128), nullable=True)
    paper_level: Mapped[str | None] = mapped_column(String(16), nullable=True)

    # ---- 关系 ----
    user: Mapped["User"] = relationship(back_populates="error_items")
    subject: Mapped["Subject | None"] = relationship(back_populates="error_items")
    tags: Mapped[list["KnowledgeTag"]] = relationship(
        secondary=error_item_tags, back_populates="error_items"
    )
    review_schedules: Mapped[list["ReviewSchedule"]] = relationship(
        back_populates="error_item", cascade="all, delete-orphan"
    )
    practice_records: Mapped[list["PracticeRecord"]] = relationship(
        back_populates="error_item"
    )

    __table_args__ = (
        # 索引
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ErrorItem id={self.id} mastery={self.mastery_level}>"


# ========== ReviewSchedule ==========
class ReviewSchedule(Base, TimestampMixin):
    __tablename__ = "review_schedules"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    error_item_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("error_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    scheduled_for: Mapped[DateTime] = mapped_column(DateTime, nullable=False)
    completed_at: Mapped[DateTime | None] = mapped_column(DateTime, nullable=True)
    is_correct: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    error_item: Mapped["ErrorItem"] = relationship(back_populates="review_schedules")


# ========== PracticeRecord ==========
class PracticeRecord(Base, TimestampMixin):
    __tablename__ = "practice_records"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    error_item_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("error_items.id", ondelete="SET NULL"), nullable=True, index=True
    )

    subject: Mapped[str | None] = mapped_column(String(64), nullable=True)
    difficulty: Mapped[str | None] = mapped_column(String(16), nullable=True)
    is_correct: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    user: Mapped["User"] = relationship(back_populates="practice_records")
    error_item: Mapped["ErrorItem | None"] = relationship(back_populates="practice_records")
