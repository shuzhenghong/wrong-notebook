"""种子数据 — 创建 admin 用户 + 系统知识点标签 (数学示例)."""

from __future__ import annotations

import os
import secrets

from sqlalchemy.orm import Session

from app.database import SessionLocal, init_db
from app.models import KnowledgeTag, User
from app.utils.auth import hash_password


def _uid() -> str:
    return secrets.token_hex(16)


def _generate_password(length: int = 20) -> str:
    """生成强随机密码 — 不含易混淆与 shell 高危字符."""
    upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"
    lower = "abcdefghijkmnopqrstuvwxyz"
    digits = "23456789"
    symbols = "-_.@#%+=*"
    alphabet = upper + lower + digits + symbols
    chars = [
        secrets.choice(upper),
        secrets.choice(lower),
        secrets.choice(digits),
        secrets.choice(symbols),
    ]
    chars += [secrets.choice(alphabet) for _ in range(max(0, length - len(chars)))]
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


def seed_admin() -> None:
    """创建管理员账号.

    安全约定:
      - 邮箱来自 DEFAULT_ADMIN_EMAIL，默认 admin@localhost
      - 密码来自 DEFAULT_ADMIN_PASSWORD；未设置时自动生成强随机密码
      - 任何情况下都不会在日志/控制台回显明文密码
      - 账号必须首次登录后修改密码 (must_change_password=True)
      - 已存在的管理员只校正 role/is_active，绝不改密码
    """
    init_db()
    email = (os.getenv("DEFAULT_ADMIN_EMAIL") or "admin@localhost").strip()
    db: Session = SessionLocal()
    try:
        existing = db.query(User).filter(User.email == email).first()
        if existing:
            updates = {}
            if existing.role != "admin":
                updates["role"] = "admin"
            if not existing.is_active:
                updates["is_active"] = True
            if updates:
                for k, v in updates.items():
                    setattr(existing, k, v)
                db.commit()
            print(f"[seed] admin {email} already exists, role/is_active corrected")
            return

        password = (os.getenv("DEFAULT_ADMIN_PASSWORD") or "").strip()
        source = "env" if password else "generated"
        if not password:
            password = _generate_password()

        admin = User(
            id=_uid(),
            email=email,
            password=hash_password(password),
            name="Admin",
            role="admin",
            is_active=True,
            must_change_password=True,
        )
        db.add(admin)
        db.commit()

        # 绝不打印明文密码。env 来源不提示（用户自己知道）；生成来源提示去哪里找凭据。
        if source == "env":
            print(f"[seed] created admin: {email} (password from DEFAULT_ADMIN_PASSWORD, not echoed)")
        else:
            print(
                "[seed] created admin: " + email + "\n"
                "       A strong random password was generated. Log in once and the system "
                "will force you to change it. Provide DEFAULT_ADMIN_PASSWORD to set your own."
            )
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
