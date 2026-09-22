"""管理员路由 — /api/admin/*."""

from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ...database import get_db
from ...models import ErrorItem, PracticeRecord, Subject, User
from ...schemas.user import UserOut
from ...utils.auth import hash_password
from ...utils.dependencies import require_admin
from ...utils.logger import get_logger


router = APIRouter()
logger = get_logger("api:admin")


def _uid() -> str:
    return secrets.token_hex(16)


class SystemResetRequest(BaseModel):
    """清库是高危操作 — 必须显式二次确认."""

    confirm: str = ""


@router.get("/dashboard")
def dashboard(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> dict:
    return {
        "users_total": db.scalar(select(func.count()).select_from(User)) or 0,
        "users_active": db.scalar(select(func.count()).select_from(User).where(User.is_active.is_(True))) or 0,
        "subjects_total": db.scalar(select(func.count()).select_from(Subject)) or 0,
        "error_items_total": db.scalar(select(func.count()).select_from(ErrorItem)) or 0,
        "practice_records_total": db.scalar(select(func.count()).select_from(PracticeRecord)) or 0,
    }


@router.get("/users", response_model=list[UserOut])
def list_users(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
    keyword: str | None = Query(None),
) -> list[User]:
    stmt = select(User).order_by(User.created_at.desc())
    if keyword:
        like = f"%{keyword}%"
        stmt = stmt.where(User.email.ilike(like) | User.name.ilike(like))
    return list(db.scalars(stmt).all())


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: dict,  # { email, password, name?, role?, is_active? }
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> User:
    email = payload.get("email")
    password = payload.get("password")
    if not email or not password:
        raise HTTPException(status_code=400, detail="email and password required")

    existing = db.query(User).filter(User.email == email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email exists")

    u = User(
        id=_uid(),
        email=email,
        password=hash_password(password),
        name=payload.get("name"),
        role=payload.get("role", "user"),
        is_active=payload.get("is_active", True),
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: str,
    payload: dict,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> User:
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    for k in ("name", "role", "is_active"):
        if k in payload:
            setattr(u, k, payload[k])
    if "password" in payload:
        u.password = hash_password(payload["password"])
    db.commit()
    db.refresh(u)
    return u


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: str,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> None:
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    if u.id == _admin.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    db.delete(u)
    db.commit()


@router.post("/system-reset")
def system_reset(
    payload: SystemResetRequest | None = None,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """危险 — 清空所有业务数据 (保留 admin 用户).

    必须传 {"confirm": "DELETE ALL DATA"} 才会真正执行,
    避免前端误触或 CSRF 直接清库.
    """
    if not payload or payload.confirm != "DELETE ALL DATA":
        raise HTTPException(
            status_code=400,
            detail='Confirmation required: send {"confirm": "DELETE ALL DATA"}',
        )

    items = db.query(ErrorItem).delete(synchronize_session=False)
    practices = db.query(PracticeRecord).delete(synchronize_session=False)
    subjects = db.query(Subject).delete(synchronize_session=False)
    db.commit()
    logger.warning(
        "SYSTEM RESET by admin %s: %d items, %d practices, %d subjects",
        admin.email, items, practices, subjects,
    )
    return {
        "message": "Reset complete (admin preserved)",
        "deleted": {"error_items": items, "practice_records": practices, "subjects": subjects},
    }


@router.post("/migrate-tags")
def admin_migrate_tags(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> dict:
    """标签系统迁移脚本 — 原 src/app/api/admin/migrate-tags/route.ts.

    把 error_items 上的 knowledge_points (JSON) 解析成 KnowledgeTag 行并建立关联.

    原实现的三个问题:
      1. KnowledgeTag.subject 是 NOT NULL, 但创建时没给 → 直接 IntegrityError
      2. 同一个 name 会为每道题重复建一行, 没有去重
      3. import 了 error_item_tags 却没用 → tag 建出来是孤立的, 没有绑到错题上
    """
    import json

    from ...models import KnowledgeTag

    items = (
        db.query(ErrorItem)
        .options(selectinload(ErrorItem.tags))
        .filter(ErrorItem.knowledge_points.isnot(None))
        .all()
    )

    # (subject, name) → tag, 用于去重; 先加载已有 tag 避免重复建
    tag_index: dict[tuple[str, str], KnowledgeTag] = {}
    for t in db.query(KnowledgeTag).all():
        tag_index.setdefault((t.subject, t.name), t)

    DEFAULT_SUBJECT = "other"
    created = 0
    linked = 0

    for item in items:
        try:
            points = json.loads(item.knowledge_points) if item.knowledge_points else []
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(points, list):
            continue

        for p in points:
            name = p if isinstance(p, str) else (p.get("name") if isinstance(p, dict) else None)
            if not name or not name.strip():
                continue
            name = name.strip()
            subject = (item.subject.name if item.subject else None) or DEFAULT_SUBJECT

            tag = tag_index.get((subject, name))
            if tag is None:
                tag = KnowledgeTag(
                    id=_uid(),
                    name=name,
                    subject=subject,
                    is_system=False,
                    user_id=item.user_id,
                )
                db.add(tag)
                db.flush()
                tag_index[(subject, name)] = tag
                created += 1

            if tag not in item.tags:
                item.tags.append(tag)
                linked += 1

    try:
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.error("migrate-tags failed: %s", exc)
        raise HTTPException(status_code=500, detail="Migration failed")

    return {
        "message": "Migration complete",
        "created_tags": created,
        "linked_relations": linked,
    }
