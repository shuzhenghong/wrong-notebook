"""认证路由 — /api/auth/* + /api/register + /api/user (对应 NextAuth + /api/user)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, model_validator
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
from ...utils.app_config import allow_registration, read_masked_config, write_config
from ...utils.auth import create_access_token, hash_password, verify_password
from ...utils.dependencies import get_bearer_token, get_current_user, require_admin
from ...utils.ids import new_id
from ...utils.logger import get_logger
from ...utils.rate_limiter import rate_limit
from ...config import reload_settings
from ...services.ai import reload_ai_service


router = APIRouter()
logger = get_logger("api:auth")

# 认证接口限流 (防密码爆破 / 注册刷号)
LOGIN_RATE_LIMIT = 10
LOGIN_RATE_WINDOW_SEC = 60
REGISTER_RATE_LIMIT = 5
REGISTER_RATE_WINDOW_SEC = 3600


def _client_key(request: Request) -> str:
    """按客户端 IP 做限流键 (反向代理后取 X-Forwarded-For 第一跳)."""
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",")[0].strip() if forwarded else ""
    return ip or (request.client.host if request.client else "unknown")


# ---------- 注册 ----------
@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def register(
    payload: UserRegister,
    request: Request,
    db: Session = Depends(get_db),
) -> User:
    if not allow_registration():
        raise HTTPException(status_code=403, detail="Registration is currently closed")

    key = _client_key(request)
    ok, _rem, retry_after = rate_limit(
        f"register:{key}", REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_SEC
    )
    if not ok:
        raise HTTPException(
            status_code=429,
            detail=f"Too many registrations. Retry after {int(retry_after)}s.",
        )

    existing = db.query(User).filter(User.email == payload.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        id=new_id(),
        email=payload.email,
        password=hash_password(payload.password),
        name=payload.name,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    logger.info("New user registered: %s", payload.email)
    return user


# ---------- 登录 ----------
@router.post("/auth/login", response_model=TokenResponse)
def login(payload: UserLogin, request: Request, db: Session = Depends(get_db)) -> TokenResponse:
    # 按 email + IP 双重限流, 避免单一来源爆破任意账号
    key = _client_key(request)
    ok, _rem, retry_after = rate_limit(
        f"login:{key}:{payload.email}", LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_SEC
    )
    if not ok:
        raise HTTPException(
            status_code=429,
            detail=f"Too many login attempts. Retry after {int(retry_after)}s.",
        )

    user = db.query(User).filter(User.email == payload.email).first()
    if not user or not verify_password(payload.password, user.password):
        logger.warning("Failed login attempt for %s from %s", payload.email, key)
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account disabled")

    settings = get_settings()
    token = create_access_token(
        subject=user.id,
        token_version=user.token_version,
        expires_delta=timedelta(minutes=settings.jwt_expire_minutes),
    )
    # 登录同时返回 user, 省前端一次 me() 调用
    user_out = UserOut.model_validate(user)
    return TokenResponse(access_token=token, user=user_out)


# ---------- 登出 (吊销当前 token) ----------
@router.post("/auth/logout")
def logout(
    user: User = Depends(get_current_user),
    token: str = Depends(get_bearer_token),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    """把当前 JWT 的 jti 加入黑名单, 使其立即失效 (单点登出).

    其余仍持有该用户 token 的设备不受影响; 若想全部踢下线请用改密.
    """
    from datetime import datetime, timezone

    from ...utils.auth import decode_access_token
    from ...utils.token_blacklist import revoke_token

    try:
        payload = decode_access_token(token)
    except Exception:  # noqa: BLE001 - 解析失败不应影响登出意图
        return {"message": "logged out"}

    jti = payload.get("jti")
    exp = payload.get("exp")
    expires_at = datetime.fromtimestamp(exp, tz=timezone.utc) if exp else None
    revoke_token(jti, expires_at, db)
    logger.info("User %s logged out (revoked jti=%s)", user.email, jti)
    return {"message": "logged out"}


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
    # 自增 token 版本: 该用户所有已签发的旧 token (tv 不匹配) 立即失效, 实现改密踢下线
    user.token_version = (user.token_version or 0) + 1
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

_SECRET_KEY_HINTS = ("key", "secret", "token", "password", "endpoint", "baseurl", "apikey")


def _is_secret_key(key: str) -> bool:
    low = key.lower().replace("_", "").replace("-", "")
    return any(hint in low for hint in _SECRET_KEY_HINTS)


class SettingsUpdate(BaseModel):
    """配置更新体 — 允许任意字段, 但密钥类字段必须是字符串.

    app-config.json 是开放结构 (由前端定义字段), 所以保留 extra=allow;
    但密钥/连接串类字段若被误传为数字/对象, 下游 provider 会静默失败,
    这里提前拦截.
    """

    model_config = {"extra": "allow"}

    @model_validator(mode="before")
    @classmethod
    def _validate_secret_types(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        for k, v in data.items():
            if v is None:
                continue
            if _is_secret_key(str(k)) and not isinstance(v, str):
                raise ValueError(
                    f"Field '{k}' looks like a secret/credential and must be a string, "
                    f"got {type(v).__name__}"
                )
        return data


@router.get("/settings")
def get_settings_py(
    _user: User = Depends(get_current_user),
) -> dict:
    """GET /api/settings — 返回掩码后的配置."""
    return read_masked_config()


@router.post("/settings")
def post_settings_py(
    body: SettingsUpdate,
    admin: User = Depends(require_admin),
) -> dict:
    """POST /api/settings — 更新全局配置 (含 AI key, 仅管理员)."""
    try:
        logger.info("Admin %s updated app-config", admin.email)
        result = write_config(body.model_dump(exclude_none=True))
        # 配置可能包含 AI provider 相关项 — 重新读取配置并重建 AI 单例,
        # 这样改完 .env / app-config 后无需重启进程即可生效.
        reload_settings()
        reload_ai_service()
        return result
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to persist config: {e}")
