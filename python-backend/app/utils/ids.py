"""统一的 ID 生成工具.

之前多个模块各自复制了一份 `_uid() -> secrets.token_hex(16)`,
集中到这里避免重复实现和风格漂移.
"""

from __future__ import annotations

import secrets


def new_id() -> str:
    """生成 32 字符十六进制随机 ID (128 位熵), 与原 cuid 风格一致."""
    return secrets.token_hex(16)
