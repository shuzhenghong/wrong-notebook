"""Base 基类."""
from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

class Base(DeclarativeBase):
    """表名/列名对齐 Prisma; Python 属性名保持 snake_case."""
    metadata = MetaData()
