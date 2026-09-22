"""Token 黑名单工具 — 登出时吊销单条 JWT (按 jti).

纯 DB 实现 (token_blacklist 表), 重启 / 多副本都生效; 不需要额外中间件.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models.token_blacklist import TokenBlacklist
from .timeutil import utc_now


def revoke_token(jti: str, expires_at: datetime | None, db: Session) -> None:
    """将 jti 加入黑名单, 并顺手清理已自然过期的记录."""
    if not jti:
        return
    db.add(TokenBlacklist(jti=jti, expires_at=expires_at))
    # 清理过期行, 控制表体积
    db.query(TokenBlacklist).filter(TokenBlacklist.expires_at < utc_now()).delete()
    db.commit()


def is_revoked(jti: str, db: Session) -> bool:
    """该 jti 是否已吊销 (无 jti 的 token 视为未吊销, 向后兼容老 token)."""
    if not jti:
        return False
    row = db.get(TokenBlacklist, jti)
    if row is None:
        return False
    # 极端情况下表里有残留但未过期 — 仍视为吊销
    return True


def token_version_valid(token_version: int | None, user_version: int) -> bool:
    """tv 声明与用户当前版本是否一致; 老 token 无 tv 时放行."""
    if token_version is None:
        return True
    return token_version == user_version
