"""User — 对齐 Prisma User 表."""
from datetime import datetime
from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .base import Base

class User(Base):
    __tablename__ = "User"
    id: Mapped[str] = mapped_column("id", String(32), primary_key=True)
    email: Mapped[str] = mapped_column("email", String(255), unique=True, nullable=False)
    password: Mapped[str] = mapped_column("password", String(255), nullable=False)
    name: Mapped[str | None] = mapped_column("name", String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    education_stage: Mapped[str | None] = mapped_column("educationStage", String(32), nullable=True)
    enrollment_year: Mapped[int | None] = mapped_column("enrollmentYear", Integer, nullable=True)
    role: Mapped[str] = mapped_column("role", String(16), default="user", nullable=False)
    is_active: Mapped[bool] = mapped_column("isActive", Boolean, default=True, nullable=False)
    must_change_password: Mapped[bool] = mapped_column("mustChangePassword", Boolean, default=False, nullable=False)

    subjects: Mapped[list["Subject"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    error_items: Mapped[list["ErrorItem"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    practice_records: Mapped[list["PracticeRecord"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    custom_tags: Mapped[list["KnowledgeTag"]] = relationship(back_populates="user", cascade="all, delete-orphan")
