"""认证路由 — /api/auth/* + /api/register + /api/user (对应 NextAuth + /api/user)."""

from __future__ import annotations

import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ...config import get_settings
from ...database import get_db
from ...models import User
from ...schemas.user import (
    ChangePassword,
    TokenResponse,
    UserLogin,
    UserOut,
    UserRegister,
    UserUpdate,
)
from ...utils.auth import create_access_token, hash_password, verify_password
from ...utils.dependencies import get_current_user


router = APIRouter()


def _uid() -> str:
    """生成 cuid 风格的短 id (足够 sqlite 用)."""
    return secrets.token_hex(16)


# ---------- 注册 ----------
@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def register(payload: UserRegister, db: Session = Depends(get_db)) -> User:
    existing = db.query(User).filter(User.email == payload.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        id=_uid(),
        email=payload.email,
        password=hash_password(payload.password),
        name=payload.name,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


# ---------- 登录 ----------
@router.post("/auth/login", response_model=TokenResponse)
def login(payload: UserLogin, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.query(User).filter(User.email == payload.email).first()
    if not user or not verify_password(payload.password, user.password):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account disabled")

    settings = get_settings()
    token = create_access_token(
        subject=user.id,
        expires_delta=timedelta(minutes=settings.jwt_expire_minutes),
    )
    return TokenResponse(access_token=token)


# ---------- 当前用户 ----------
@router.get("/user/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> User:
    return user


@router.patch("/user/me", response_model=UserOut)
def update_me(
    payload: UserUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(user, field, value)
    db.commit()
    db.refresh(user)
    return user


@router.post("/user/change-password")
def change_password(
    payload: ChangePassword,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    if not verify_password(payload.old_password, user.password):
        raise HTTPException(status_code=400, detail="Old password incorrect")
    user.password = hash_password(payload.new_password)
    user.must_change_password = False
    db.commit()
    return {"message": "Password changed"}
