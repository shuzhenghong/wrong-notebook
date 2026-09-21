"""管理员路由 — /api/admin/*."""

from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...database import get_db
from ...models import ErrorItem, PracticeRecord, Subject, User
from ...schemas.user import UserOut
from ...utils.auth import hash_password
from ...utils.dependencies import require_admin


router = APIRouter()


def _uid() -> str:
    return secrets.token_hex(16)


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
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> dict:
    """危险 — 清空所有业务数据 (保留 admin 用户)."""
    db.query(ErrorItem).delete(synchronize_session=False)
    db.query(PracticeRecord).delete(synchronize_session=False)
    db.query(Subject).delete(synchronize_session=False)
    db.commit()
    return {"message": "Reset complete (admin preserved)"}
