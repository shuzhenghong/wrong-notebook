"""知识点标签路由 — /api/tags/*."""

from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...database import get_db
from ...models import ErrorItem, KnowledgeTag, User
from ...schemas.notebook import KnowledgeTagCreate, KnowledgeTagOut, KnowledgeTagUpdate
from ...utils.dependencies import get_current_user


router = APIRouter()


def _uid() -> str:
    return secrets.token_hex(16)


def _build_tree(nodes: list[KnowledgeTag], parent_id: str | None = None) -> list[KnowledgeTagOut]:
    out: list[KnowledgeTagOut] = []
    for n in nodes:
        if n.parent_id == parent_id:
            out.append(
                KnowledgeTagOut(
                    id=n.id,
                    name=n.name,
                    subject=n.subject,
                    parent_id=n.parent_id,
                    code=n.code,
                    order=n.order,
                    is_system=n.is_system,
                    children=_build_tree(nodes, n.id),
                )
            )
    out.sort(key=lambda x: x.order)
    return out


# ---------- 列表 (平铺 + 按 subject) ----------
@router.get("", response_model=list[KnowledgeTagOut])
def list_tags(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    subject: str | None = Query(None),
    tree: bool = Query(True),
) -> list[KnowledgeTagOut]:
    stmt = select(KnowledgeTag).where(
        or_(KnowledgeTag.is_system.is_(True), KnowledgeTag.user_id == user.id)
    )
    if subject:
        stmt = stmt.where(KnowledgeTag.subject == subject)
    tags = db.scalars(stmt.order_by(KnowledgeTag.subject, KnowledgeTag.order)).all()
    if tree:
        return _build_tree(tags)
    return [
        KnowledgeTagOut(
            id=t.id, name=t.name, subject=t.subject, parent_id=t.parent_id,
            code=t.code, order=t.order, is_system=t.is_system, children=[],
        )
        for t in tags
    ]


# ---------- 创建 ----------
@router.post("", response_model=KnowledgeTagOut, status_code=status.HTTP_201_CREATED)
def create_tag(
    payload: KnowledgeTagCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> KnowledgeTagOut:
    if payload.parent_id:
        parent = db.get(KnowledgeTag, payload.parent_id)
        if not parent:
            raise HTTPException(status_code=400, detail="parent_id not found")

    tag = KnowledgeTag(
        id=_uid(),
        name=payload.name,
        subject=payload.subject,
        parent_id=payload.parent_id,
        code=payload.code,
        order=payload.order,
        is_system=False,
        user_id=user.id,
    )
    db.add(tag)
    db.commit()
    db.refresh(tag)
    return KnowledgeTagOut(
        id=tag.id, name=tag.name, subject=tag.subject, parent_id=tag.parent_id,
        code=tag.code, order=tag.order, is_system=tag.is_system, children=[],
    )


# ---------- 更新 ----------
@router.patch("/{tag_id}", response_model=KnowledgeTagOut)
def update_tag(
    tag_id: str,
    payload: KnowledgeTagUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> KnowledgeTagOut:
    tag = db.get(KnowledgeTag, tag_id)
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    if tag.is_system:
        raise HTTPException(status_code=400, detail="System tags are read-only")
    if tag.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not your tag")

    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(tag, k, v)
    db.commit()
    db.refresh(tag)
    return KnowledgeTagOut(
        id=tag.id, name=tag.name, subject=tag.subject, parent_id=tag.parent_id,
        code=tag.code, order=tag.order, is_system=tag.is_system, children=[],
    )


# ---------- 删除 ----------
@router.delete("/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tag(
    tag_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    tag = db.get(KnowledgeTag, tag_id)
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    if tag.is_system:
        raise HTTPException(status_code=400, detail="System tags cannot be deleted")
    if tag.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not your tag")
    db.delete(tag)
    db.commit()


# ---------- 建议 ----------
@router.get("/suggestions", response_model=list[str])
def suggest_tags(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    subject: str | None = Query(None),
    keyword: str | None = Query(None),
    limit: int = Query(20, ge=1, le=100),
) -> list[str]:
    stmt = select(KnowledgeTag.name).distinct().where(
        or_(KnowledgeTag.is_system.is_(True), KnowledgeTag.user_id == user.id)
    )
    if subject:
        stmt = stmt.where(KnowledgeTag.subject == subject)
    if keyword:
        stmt = stmt.where(KnowledgeTag.name.ilike(f"%{keyword}%"))
    return list(db.scalars(stmt.limit(limit)).all())


# ---------- 统计 ----------
@router.get("/stats", response_model=list[dict])
def tag_stats(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    subject: str | None = Query(None),
) -> list[dict]:
    """按 tag 统计错题数量."""
    from sqlalchemy import join as sa_join
    from sqlalchemy import label

    stmt = (
        db.query(KnowledgeTag.id, KnowledgeTag.name, KnowledgeTag.subject,
                 func.count(ErrorItem.id).label("count"))
        .outerjoin(ErrorItem.tags)
        .where(
            or_(KnowledgeTag.is_system.is_(True), KnowledgeTag.user_id == user.id),
            or_(ErrorItem.user_id == user.id, ErrorItem.id.is_(None)),
        )
        .group_by(KnowledgeTag.id, KnowledgeTag.name, KnowledgeTag.subject)
    )
    if subject:
        stmt = stmt.where(KnowledgeTag.subject == subject)

    rows = stmt.all()
    return [
        {"id": r.id, "name": r.name, "subject": r.subject, "count": r.count}
        for r in rows
    ]


# 需要引入 or_ 在 suggest_tags 里, 用 importlib 补救下
from sqlalchemy import or_  # noqa: E402
