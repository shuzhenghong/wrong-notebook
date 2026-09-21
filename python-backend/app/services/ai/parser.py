"""从 XML 格式输出中解析标签值."""

from __future__ import annotations

import re
from typing import Any


_XML_TAG_RE = re.compile(r"<(\w+)>(.*?)</\1>", re.DOTALL)


def extract_xml_tags(text: str) -> dict[str, str]:
    """把 AI 返回的 XML 片段解析为 dict. 标签名 → 内容."""
    result: dict[str, str] = {}
    for m in _XML_TAG_RE.finditer(text or ""):
        result[m.group(1)] = m.group(2).strip()
    return result


def split_csv(text: str | None) -> list[str]:
    """逗号分隔字符串 → 列表."""
    if not text:
        return []
    return [t.strip() for t in text.split(",") if t.strip()]


def parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"true", "1", "yes", "y"}


def parse_int(value: str | None, default: int | None = None) -> int | None:
    if value is None:
        return default
    try:
        return int(value.strip())
    except ValueError:
        return default


def parse_list(value: str | None, sep: str = "\n") -> list[str]:
    if not value:
        return []
    return [v.strip() for v in value.split(sep) if v.strip()]


def safe_get(d: dict[str, Any], key: str, default: Any = None) -> Any:
    """可选链风格取值."""
    v = d.get(key)
    return v if v is not None else default
