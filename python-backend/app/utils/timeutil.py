"""时间工具 — 统一 UTC 语义.

数据库里 created_at/updated_at 存的是 naive datetime (SQLite 的 DateTime
列不带时区信息), 所以这里返回 **naive UTC**, 与列里的值同口径比较.

直接用 datetime.utcnow() 在 Python 3.12+ 已废弃, 会打 DeprecationWarning 并在
未来版本被移除; 而 datetime.now(timezone.utc) 是 aware 的, 拿来和 naive 列
比较会出问题. 所以统一走这个 helper.
"""

from __future__ import annotations

from datetime import datetime, timezone


def utc_now() -> datetime:
    """当前 UTC 时间 (naive, 与数据库 DateTime 列口径一致)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def month_keys(count: int = 6, today: datetime | None = None) -> list[str]:
    """返回最近 count 个月的 'YYYY-MM' 键, 升序.

    原实现用 `now - timedelta(days=30 * i)` 估算月份, 30*5=150 天并不等于
    5 个自然月, 会导致月度图表的分桶和真实月份错位.
    """
    base = today or utc_now()
    year, month = base.year, base.month
    keys: list[str] = []
    for i in range(count - 1, -1, -1):
        m = month - i
        y = year + (m - 1) // 12
        m = (m - 1) % 12 + 1
        keys.append(f"{y:04d}-{m:02d}")
    return keys
