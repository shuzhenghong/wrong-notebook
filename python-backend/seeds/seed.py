"""种子数据 — 创建 admin 用户 + 系统知识点标签 (数学示例)."""

from __future__ import annotations

import secrets

from sqlalchemy.orm import Session

from app.database import SessionLocal, init_db
from app.models import KnowledgeTag, User
from app.utils.auth import hash_password


def _uid() -> str:
    return secrets.token_hex(16)


def seed_admin(email: str = "admin@example.com", password: str = "admin123") -> None:
    init_db()
    db: Session = SessionLocal()
    try:
        if db.query(User).filter(User.email == email).first():
            print(f"[seed] admin {email} already exists, skip")
            return
        admin = User(
            id=_uid(),
            email=email,
            password=hash_password(password),
            name="Admin",
            role="admin",
            is_active=True,
            must_change_password=False,
        )
        db.add(admin)
        db.commit()
        print(f"[seed] created admin: {email} / {password}")
    finally:
        db.close()


def seed_knowledge_tags() -> None:
    init_db()
    db: Session = SessionLocal()
    try:
        if db.query(KnowledgeTag).filter(KnowledgeTag.is_system.is_(True)).count() > 0:
            print("[seed] system tags already exist, skip")
            return

        math_root = KnowledgeTag(
            id=_uid(), name="数学", subject="math",
            is_system=True, order=0, code="math",
        )
        db.add(math_root)
        db.flush()

        children = [
            ("代数", "1", 0),
            ("几何", "2", 1),
            ("函数", "3", 2),
            ("概率与统计", "4", 3),
        ]
        for name, code, order in children:
            db.add(KnowledgeTag(
                id=_uid(), name=name, subject="math",
                parent_id=math_root.id, code=code, order=order, is_system=True,
            ))

        db.commit()
        print("[seed] system knowledge tags created")
    finally:
        db.close()


if __name__ == "__main__":
    init_db()
    seed_admin()
    seed_knowledge_tags()
    print("[seed] done")
