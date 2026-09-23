"""错题 CRUD 路由 — /api/error-items/*."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from ...database import get_db
from ...models import ErrorItem, KnowledgeTag, Subject, User
from ...schemas.ai import MessageResponse
from ...schemas.error_item import (
    ErrorItemCreate,
    ErrorItemListResponse,
    ErrorItemOut,
    ErrorItemUpdate,
)
from ...utils.dependencies import get_current_user
from ...utils.ids import new_id
from ...utils.image_storage import (
    delete_image,
    is_inline_image,
    store_image as _store_image,
)


router = APIRouter()


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

    filters = [ErrorItem.user_id == user.id]
    if subject_id:
        filters.append(ErrorItem.subject_id == subject_id)
    if mastery_level is not None:
        filters.append(ErrorItem.mastery_level == mastery_level)
    if keyword:
        like = f"%{keyword}%"
        filters.append(
            or_(
                ErrorItem.question_text.ilike(like),
                ErrorItem.analysis.ilike(like),
                ErrorItem.user_notes.ilike(like),
                ErrorItem.source.ilike(like),
            )
        )
    if tag_id:
        # 用 EXISTS 而不是 JOIN: JOIN 会让"一题多标签"的行重复出现,
        # 导致 count 偏大且分页数量与列表对不上.
        filters.append(ErrorItem.tags.any(KnowledgeTag.id == tag_id))

    # 总数
    total = db.scalar(select(func.count()).select_from(ErrorItem).where(*filters)) or 0

    # 单次查询: 预加载关系 + 排序 + 分页一次搞定
    # (原实现先查 id 再按 id 查一遍, 第二次查询丢了 order_by, 顺序会漂移)
    stmt = (
        select(ErrorItem)
        .where(*filters)
        .options(selectinload(ErrorItem.subject), selectinload(ErrorItem.tags))
        .order_by(ErrorItem.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    items = db.scalars(stmt).all()
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

    item_id = new_id()
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
        mastery_level=payload.mastery_level,
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


def _delete_items_and_images(db: Session, stmt_filters) -> int:  # noqa: ANN001
    """按条件批量删除错题, 并同步清理磁盘上的图片文件."""
    keys = [
        k
        for (k,) in db.query(ErrorItem.image_storage_key)
        .filter(*stmt_filters, ErrorItem.image_storage_key.isnot(None))
        .all()
    ]
    deleted = db.query(ErrorItem).filter(*stmt_filters).delete(synchronize_session=False)
    db.commit()
    for k in keys:
        delete_image(k)
    return deleted


# ---------- 删除 ----------
@router.delete("/clear")
def clear_all_nextjs_compat(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Next.js 兼容端点 — 委托给 clear_all 逻辑."""
    deleted = _delete_items_and_images(db, [ErrorItem.user_id == user.id])
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
    deleted = _delete_items_and_images(
        db, [ErrorItem.id.in_(ids), ErrorItem.user_id == user.id]
    )
    return MessageResponse(message=f"Deleted {deleted} items")


# ---------- 清空 ----------
@router.delete("", response_model=MessageResponse)
def clear_all(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MessageResponse:
    deleted = _delete_items_and_images(db, [ErrorItem.user_id == user.id])
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
