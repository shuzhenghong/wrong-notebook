"""认证工具 — 密码哈希 + JWT (对应 NextAuth.js + bcryptjs)."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
from jose import jwt

from ..config import get_settings


def hash_password(password: str) -> str:
    """明文 → bcrypt 哈希 (返回 str)."""
    # truncate to 72 bytes to satisfy bcrypt 4.x strict check
    pwd_bytes = password.encode("utf-8")[:72]
    return bcrypt.hashpw(pwd_bytes, bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """明文 vs 哈希."""
    pwd_bytes = plain.encode("utf-8")[:72]
    return bcrypt.checkpw(pwd_bytes, hashed.encode("utf-8"))


def create_access_token(
    subject: str,
    token_version: int = 0,
    expires_delta: timedelta | None = None,
) -> str:
    """生成 JWT access token.

    额外写入:
    - jti: 唯一 ID, 用于登出时进黑名单精确吊销单条 token.
    - tv:  token_version, 改密后自增即可让该用户所有旧 token 集体失效.
    两者缺失时 (老 token) 解析端会向后兼容, 不做强制校验.
    """
    settings = get_settings()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.jwt_expire_minutes)
    )
    payload: dict[str, Any] = {
        "sub": subject,
        "exp": expire,
        "iat": datetime.now(timezone.utc),
        "jti": uuid.uuid4().hex,
        "tv": token_version,
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict[str, Any]:
    """解析并验证 JWT. 失败抛出 JWTError."""
    settings = get_settings()
    return jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
