"""FastAPI 依赖 — 从 Authorization header 解析当前用户."""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status
from jose import JWTError
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User
from .auth import decode_access_token


def get_token(request: Request) -> str:
    """从 Bearer header 提取 token."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header",
        )
    return auth.removeprefix("Bearer ").strip()


def get_current_user(
    token: str = Depends(get_token),
    db: Session = Depends(get_db),
) -> User:
    """FastAPI 依赖: 解析 token 返回当前 User."""
    try:
        payload = decode_access_token(token)
        user_id: str | None = payload.get("sub")
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )

    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")

    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or disabled")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    """FastAPI 依赖: 当前用户必须是 admin."""
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return user
