"""错题 CRUD 路由 — /api/error-items/*."""

from __future__ import annotations

import secrets
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, selectinload

from ...database import get_db
from ...models import ErrorItem, KnowledgeTag, Subject, User, error_item_tags
from ...schemas.ai import MessageResponse
from ...schemas.error_item import (
    ErrorItemCreate,
    ErrorItemListResponse,
    ErrorItemOut,
    ErrorItemUpdate,
)
from ...utils.dependencies import get_current_user
from ...utils.image_storage import is_inline_image, store_image as _store_image


router = APIRouter()


def _uid() -> str:
    return secrets.token_hex(16)


def _maybe_store_image(user_id: str, item_id: str, original_image_url: str | None) -> tuple[str | None, str | None, str | None]:
    """若图片是 inline base64 则自动落盘, 返回 (storage_key, mime, url); 否则原样返回."""
    if not original_image_url or not is_inline_image(original_image_url):
        return None, None, None
    stored = _store_image(user_id, item_id, original_image_url)
    if stored is None:
        return None, None, None
    return stored.storage_key, stored.mime_type, stored.url


def _to_out(item: ErrorItem, db: Session) -> ErrorItemOut:
    subject_name = item.subject.name if item.subject else None
    tags = [
        {"id": t.id, "name": t.name, "subject": t.subject}
        for t in item.tags
    ]
    return ErrorItemOut(
        id=item.id,
        subject_id=item.subject_id,
        subject_name=subject_name,
        original_image_url=item.original_image_url,
        reference_image_url=item.reference_image_url,
        wrong_answer_image_url=item.wrong_answer_image_url,
        question_text=item.question_text,
        answer_text=item.answer_text,
        analysis=item.analysis,
        wrong_answer_text=item.wrong_answer_text,
        mistake_analysis=item.mistake_analysis,
        mistake_status=item.mistake_status,
        source=item.source,
        error_type=item.error_type,
        user_notes=item.user_notes,
        mastery_level=item.mastery_level,
        grade_semester=item.grade_semester,
        paper_level=item.paper_level,
        tags=tags,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


def _sync_tags(item: ErrorItem, tag_ids: list[str], db: Session) -> None:
    """设置错题关联的知识点标签 (覆盖式)."""
    if not tag_ids:
        item.tags = []
        return
    tags = db.query(KnowledgeTag).filter(KnowledgeTag.id.in_(tag_ids)).all()
    item.tags = tags


# ---------- 列表 ----------
@router.get("", response_model=ErrorItemListResponse)
def list_error_items(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    subject_id: str | None = None,
    notebook_id: str | None = Query(None, alias="notebookId"),  # 前端兼容
    mastery_level: int | None = Query(None, ge=0, le=2),
    keyword: str | None = None,
    tag_id: str | None = None,
) -> ErrorItemListResponse:
    # 兼容 notebookId → subject_id
    if notebook_id and not subject_id:
        subject_id = notebook_id

    stmt = select(ErrorItem).where(ErrorItem.user_id == user.id)
    if subject_id:
        stmt = stmt.where(ErrorItem.subject_id == subject_id)
    if mastery_level is not None:
        stmt = stmt.where(ErrorItem.mastery_level == mastery_level)
    if keyword:
        like = f"%{keyword}%"
        stmt = stmt.where(
            or_(
                ErrorItem.question_text.ilike(like),
                ErrorItem.analysis.ilike(like),
                ErrorItem.user_notes.ilike(like),
                ErrorItem.source.ilike(like),
            )
        )
    if tag_id:
        stmt = stmt.join(ErrorItem.tags).where(KnowledgeTag.id == tag_id)

    # 总数
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0

    stmt = stmt.order_by(ErrorItem.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
    items = db.scalars(stmt.unique()) if tag_id else db.scalars(stmt)
    # 预加载 tags + subject
    items = (
        db.query(ErrorItem)
        .options(selectinload(ErrorItem.subject), selectinload(ErrorItem.tags))
        .filter(ErrorItem.id.in_([i.id for i in items]))
        .all()
    )
    return ErrorItemListResponse(
        items=[_to_out(i, db) for i in items],
        total=total,
        page=page,
        page_size=page_size,
    )


# ---------- 创建 ----------
@router.post("", response_model=ErrorItemOut, status_code=status.HTTP_201_CREATED)
def create_error_item(
    payload: ErrorItemCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ErrorItemOut:
    subject_id = payload.subject_id
    if subject_id:
        s = db.get(Subject, subject_id)
        if not s or s.user_id != user.id:
            raise HTTPException(status_code=400, detail="Invalid subject_id")

    item_id = _uid()
    # 若前端只传了 inline base64 originalImageUrl, 自动落盘
    auto_key, auto_mime, auto_url = _maybe_store_image(user.id, item_id, payload.original_image_url)

    item = ErrorItem(
        id=item_id,
        user_id=user.id,
        subject_id=subject_id,
        original_image_url=auto_url or payload.original_image_url,
        image_storage_key=payload.image_storage_key or auto_key,
        image_mime_type=payload.image_mime_type or auto_mime,
        reference_image_url=payload.reference_image_url,
        wrong_answer_image_url=payload.wrong_answer_image_url,
        ocr_text=payload.ocr_text,
        question_text=payload.question_text,
        answer_text=payload.answer_text,
        analysis=payload.analysis,
        wrong_answer_text=payload.wrong_answer_text,
        mistake_analysis=payload.mistake_analysis,
        mistake_status=payload.mistake_status,
        source=payload.source,
        error_type=payload.error_type,
        user_notes=payload.user_notes,
        grade_semester=payload.grade_semester,
        paper_level=payload.paper_level,
    )
    db.add(item)
    db.flush()
    _sync_tags(item, payload.tag_ids, db)
    db.commit()

    db.refresh(item)
    if item.subject: db.refresh(item.subject)
    return _to_out(item, db)


# ---------- 详情 ----------
@router.get("/{item_id}", response_model=ErrorItemOut)
def get_error_item(
    item_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ErrorItemOut:
    item = (
        db.query(ErrorItem)
        .options(selectinload(ErrorItem.subject), selectinload(ErrorItem.tags))
        .filter(ErrorItem.id == item_id, ErrorItem.user_id == user.id)
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="ErrorItem not found")
    return _to_out(item, db)


# ---------- 更新 ----------
@router.patch("/{item_id}", response_model=ErrorItemOut)
def update_error_item(
    item_id: str,
    payload: ErrorItemUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ErrorItemOut:
    item = db.get(ErrorItem, item_id)
    if not item or item.user_id != user.id:
        raise HTTPException(status_code=404, detail="ErrorItem not found")

    data = payload.model_dump(exclude_unset=True)
    tag_ids = data.pop("tag_ids", None)
    subject_id = data.pop("subject_id", None)

    for k, v in data.items():
        setattr(item, k, v)

    if subject_id is not None:
        if subject_id:
            s = db.get(Subject, subject_id)
            if not s or s.user_id != user.id:
                raise HTTPException(status_code=400, detail="Invalid subject_id")
        item.subject_id = subject_id

    if tag_ids is not None:
        _sync_tags(item, tag_ids, db)

    db.commit()
    db.refresh(item)
    if item.subject: db.refresh(item.subject)
    return _to_out(item, db)


# ---------- 删除 ----------
@router.delete("/clear")
def clear_all_nextjs_compat(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Next.js 兼容端点 — 委托给 clear_all 逻辑."""
    deleted = (
        db.query(ErrorItem)
        .filter(ErrorItem.user_id == user.id)
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"message": f"Cleared {deleted} items", "count": deleted}

@router.post("/batch-delete", response_model=MessageResponse)
def batch_delete(
    payload: dict[str, list[str]],
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MessageResponse:
    ids = payload.get("ids", [])
    if not ids:
        return MessageResponse(message="No ids")
    deleted = (
        db.query(ErrorItem)
        .filter(ErrorItem.id.in_(ids), ErrorItem.user_id == user.id)
        .delete(synchronize_session=False)
    )
    db.commit()
    return MessageResponse(message=f"Deleted {deleted} items")


# ---------- 清空 ----------
@router.delete("", response_model=MessageResponse)
def clear_all(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MessageResponse:
    deleted = (
        db.query(ErrorItem)
        .filter(ErrorItem.user_id == user.id)
        .delete(synchronize_session=False)
    )
    db.commit()
    return MessageResponse(message=f"Cleared {deleted} items")


# =====================================================================
# Next.js 兼容层 — Next.js 前端调 /api/error-items/clear
# 路径不同但语义相同 (Python 原生 DELETE /api/error-items)
# =====================================================================

@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_error_item(
    item_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    item = db.get(ErrorItem, item_id)
    if not item or item.user_id != user.id:
        raise HTTPException(status_code=404, detail="ErrorItem not found")
    db.delete(item)
    db.commit()


# ---------- 批量删除 ----------
