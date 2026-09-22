"""FastAPI 依赖 — 当前用户解析.

渐进迁移双模式:
  1. 原生模式: Authorization: Bearer <jwt> (Python 自己的 JWT)
  2. Next.js 桥接模式: X-Forwarded-User: <base64 json>
     —— 由 Next.js catch-all route 注入, FastAPI 用 email 做 lazy mirror 用户同步

生产环境 (TRUST_X_FORWARDED_USER=false, 默认) 只接受 JWT, 不伪造 header.
"""

from __future__ import annotations

import base64
import json
import secrets

from fastapi import Depends, HTTPException, Request, status
from jose import JWTError
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import User
from .auth import decode_access_token, hash_password
from .token_blacklist import is_revoked, token_version_valid


def _trust_forwarded() -> bool:
    """是否信任 Next.js 内网转发的 X-Forwarded-User header.

    统一走 settings (TRUST_X_FORWARDED_USER), 不再直接读 os.environ,
    保证和 .env / 其他配置项的优先级一致.
    """
    return get_settings().trust_x_forwarded_user


def _generate_cuid() -> str:
    """和原有 cuid 风格一致的短 id."""
    return secrets.token_hex(16)


def _resolve_from_forwarded_user(request: Request, db: Session) -> User | None:
    """从 Next.js 转发来的 X-Forwarded-User header 解析用户 (lazy mirror)."""
    header_val = request.headers.get("x-forwarded-user", "")
    if not header_val or header_val == "anonymous":
        return None
    if not _trust_forwarded():
        # 不信任转发 — 忽略 header, 当作没带
        return None

    try:
        decoded = base64.b64decode(header_val).decode("utf-8")
        data = json.loads(decoded)
    except Exception:
        return None

    email = data.get("email") or data.get("id")
    if not email:
        return None
    role = data.get("role", "user")

    # 按 email 查本地用户
    user = db.query(User).filter(User.email == email).first()
    if user:
        # 同步 role (Next.js 可能后台改了)
        if user.role != role:
            user.role = role
            db.commit()
        return user

    # Lazy mirror: 自动创建一个镜像用户, 密码是临时的 (Next.js 那边管认证)
    user = User(
        id=_generate_cuid(),
        email=email,
        password=hash_password("mirror-" + secrets.token_urlsafe(24)),
        name=None,
        role=role,
        is_active=True,
        must_change_password=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _resolve_from_bearer(request: Request, db: Session) -> User | None:
    """从 Authorization: Bearer <jwt> 解析用户."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth.removeprefix("Bearer ").strip()
    if not token:
        return None

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

    # ---- JWT 失效校验 ----
    # 1) 单点登出: 该 jti 是否在黑名单里
    jti = payload.get("jti")
    if is_revoked(jti, db):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Token has been revoked (logged out)"
        )
    # 2) 改密作废: token 的 tv 与用户当前 token_version 不一致即失效
    if not token_version_valid(payload.get("tv"), user.token_version):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired (credential changed)"
        )

    return user


def get_bearer_token(request: Request) -> str:
    """提取原始 Bearer token (不解析), 供登出等需要 jti 的接口使用."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token"
        )
    token = auth.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Empty bearer token")
    return token


def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
) -> User:
    """FastAPI 依赖: 综合解析 (Bearer JWT 优先 → X-Forwarded-User 桥接)."""
    user = _resolve_from_bearer(request, db)
    if user is None:
        user = _resolve_from_forwarded_user(request, db)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )
    return user


def get_current_user_optional(
    request: Request,
    db: Session = Depends(get_db),
) -> User | None:
    """可选认证 — 没登录也能继续, 后续自己处理匿名逻辑."""
    try:
        user = _resolve_from_bearer(request, db)
        if user is None:
            user = _resolve_from_forwarded_user(request, db)
        return user
    except HTTPException:
        return None


def require_admin(user: User = Depends(get_current_user)) -> User:
    """FastAPI 依赖: 当前用户必须是 admin."""
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return user
