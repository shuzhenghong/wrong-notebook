"""Subject / ErrorItem / ReviewSchedule / PracticeRecord — Prisma schema 对齐."""
from datetime import datetime
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Table, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .base import Base

# 中间表 (Prisma 约定列名 A/B)
error_item_tags = Table(
    "_ErrorItemToKnowledgeTag", Base.metadata,
    Column("A", String(32), ForeignKey("ErrorItem.id", ondelete="CASCADE"), primary_key=True),
    Column("B", String(32), ForeignKey("KnowledgeTag.id", ondelete="CASCADE"), primary_key=True),
)

class Subject(Base):
    __tablename__ = "Subject"
    id: Mapped[str] = mapped_column("id", String(32), primary_key=True)
    name: Mapped[str] = mapped_column("name", String(255), nullable=False)
    user_id: Mapped[str] = mapped_column("userId", ForeignKey("User.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    user: Mapped["User"] = relationship(back_populates="subjects")
    error_items: Mapped[list["ErrorItem"]] = relationship(back_populates="subject")

class ErrorItem(Base):
    __tablename__ = "ErrorItem"
    id: Mapped[str] = mapped_column("id", String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column("userId", ForeignKey("User.id", ondelete="CASCADE"), nullable=False)
    subject_id: Mapped[str | None] = mapped_column("subjectId", ForeignKey("Subject.id", ondelete="CASCADE"), nullable=True)
    original_image_url: Mapped[str] = mapped_column("originalImageUrl", Text, nullable=False)
    image_storage_key: Mapped[str | None] = mapped_column("imageStorageKey", String(255), nullable=True)
    image_mime_type: Mapped[str | None] = mapped_column("imageMimeType", String(64), nullable=True)
    reference_image_url: Mapped[str | None] = mapped_column("referenceImageUrl", Text, nullable=True)
    wrong_answer_image_url: Mapped[str | None] = mapped_column("wrongAnswerImageUrl", Text, nullable=True)
    ocr_text: Mapped[str | None] = mapped_column("ocrText", Text, nullable=True)
    question_text: Mapped[str | None] = mapped_column("questionText", Text, nullable=True)
    answer_text: Mapped[str | None] = mapped_column("answerText", Text, nullable=True)
    analysis: Mapped[str | None] = mapped_column("analysis", Text, nullable=True)
    wrong_answer_text: Mapped[str | None] = mapped_column("wrongAnswerText", Text, nullable=True)
    mistake_analysis: Mapped[str | None] = mapped_column("mistakeAnalysis", Text, nullable=True)
    mistake_status: Mapped[str | None] = mapped_column("mistakeStatus", String(32), nullable=True)
    knowledge_points: Mapped[str | None] = mapped_column("knowledgePoints", Text, nullable=True)
    geogebra_commands: Mapped[str | None] = mapped_column("geogebraCommands", Text, nullable=True)
    geogebra_suitable: Mapped[bool | None] = mapped_column("geogebraSuitable", Boolean, nullable=True)
    source: Mapped[str | None] = mapped_column("source", String(255), nullable=True)
    error_type: Mapped[str | None] = mapped_column("errorType", String(64), nullable=True)
    user_notes: Mapped[str | None] = mapped_column("userNotes", Text, nullable=True)
    mastery_level: Mapped[int] = mapped_column("masteryLevel", Integer, default=0, nullable=False)
    grade_semester: Mapped[str | None] = mapped_column("gradeSemester", String(128), nullable=True)
    paper_level: Mapped[str | None] = mapped_column("paperLevel", String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    user: Mapped["User"] = relationship(back_populates="error_items")
    subject: Mapped["Subject | None"] = relationship(back_populates="error_items")
    tags: Mapped[list["KnowledgeTag"]] = relationship(secondary="_ErrorItemToKnowledgeTag", back_populates="error_items")
    review_schedules: Mapped[list["ReviewSchedule"]] = relationship(back_populates="error_item", cascade="all, delete-orphan")
    practice_records: Mapped[list["PracticeRecord"]] = relationship(back_populates="error_item")

class ReviewSchedule(Base):
    __tablename__ = "ReviewSchedule"
    id: Mapped[str] = mapped_column("id", String(32), primary_key=True)
    error_item_id: Mapped[str] = mapped_column("errorItemId", ForeignKey("ErrorItem.id", ondelete="CASCADE"), nullable=False)
    scheduled_for: Mapped[datetime] = mapped_column("scheduledFor", DateTime, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column("completedAt", DateTime, nullable=True)
    is_correct: Mapped[bool | None] = mapped_column("isCorrect", Boolean, nullable=True)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, default=datetime.utcnow, nullable=False)
    error_item: Mapped["ErrorItem"] = relationship(back_populates="review_schedules")

class PracticeRecord(Base):
    __tablename__ = "PracticeRecord"
    id: Mapped[str] = mapped_column("id", String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column("userId", ForeignKey("User.id", ondelete="CASCADE"), nullable=False)
    error_item_id: Mapped[str | None] = mapped_column("errorItemId", ForeignKey("ErrorItem.id", ondelete="SET NULL"), nullable=True)
    subject: Mapped[str | None] = mapped_column("subject", String(64), nullable=True)
    difficulty: Mapped[str | None] = mapped_column("difficulty", String(16), nullable=True)
    is_correct: Mapped[bool | None] = mapped_column("isCorrect", Boolean, nullable=True)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, default=datetime.utcnow, nullable=False)
    user: Mapped["User"] = relationship(back_populates="practice_records")
    error_item: Mapped["ErrorItem | None"] = relationship(back_populates="practice_records")
