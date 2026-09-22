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
    from ...schemas.user import UserOut
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
    # 登录同时返回 user, 省前端一次 me() 调用
    user_out = UserOut.model_validate(user)
    return TokenResponse(access_token=token, user=user_out)


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


# =====================================================================
# Next.js 兼容层 — Next.js 前端调 /api/user (不是 /api/user/me)
# =====================================================================

@router.get("/user", response_model=UserOut)
def user_nextjs_compat_get(user: User = Depends(get_current_user)) -> User:
    """Next.js 兼容: GET /api/user → /api/user/me."""
    return user


@router.patch("/user", response_model=UserOut)
def user_nextjs_compat_patch(
    payload: UserUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    """Next.js 兼容: PATCH /api/user → /api/user/me."""
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(user, field, value)
    db.commit()
    db.refresh(user)
    return user



# =====================================================================
# /api/settings — 用户配置 (不在 auth_router 挂载, 直接在 api_router 层)
# =====================================================================

def _mask(k):
    if not k: return k
    return "********"

def _get_app_cfg():
    import json
    try:
        with open("app-config.json") as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
    def mask(c):
        if isinstance(c, dict):
            return {k: (mask(v) if "key" not in k.lower() and k not in ("endpoint","baseUrl") else _mask(v) if isinstance(v, str) else v) for k, v in c.items()}
        return c
    return mask(cfg)

def _update_app_cfg(body):
    import json
    try:
        with open("app-config.json") as f:
            cur = json.load(f)
    except Exception:
        cur = {}
    def merge(t, s):
        for k, v in s.items():
            if isinstance(v, dict) and isinstance(t.get(k), dict):
                merge(t[k], v)
            else:
                t[k] = v
        return t
    merge(cur, body)
    with open("app-config.json", "w") as f:
        json.dump(cur, f, indent=2, ensure_ascii=False)
    return _get_app_cfg()


@router.get("/settings")
def get_settings_py(
    _user: User = Depends(get_current_user),
) -> dict:
    """GET /api/settings — 返回掩码后的配置."""
    return _get_app_cfg()


@router.post("/settings")
def post_settings_py(
    body: dict,
    _user: User = Depends(get_current_user),
) -> dict:
    """POST /api/settings — 更新配置."""
    try:
        return _update_app_cfg(body)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
