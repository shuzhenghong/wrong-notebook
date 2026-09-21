"""错题本 (Subject) 路由 — /api/notebooks/*."""

from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...database import get_db
from ...models import ErrorItem, Subject, User
from ...schemas.notebook import SubjectCreate, SubjectOut, SubjectUpdate
from ...utils.dependencies import get_current_user


router = APIRouter()


def _uid() -> str:
    return secrets.token_hex(16)


# ---------- 列表 ----------
@router.get("", response_model=list[SubjectOut])
def list_notebooks(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[SubjectOut]:
    # 查询错题数: 子查询
    stmt = select(Subject).where(Subject.user_id == user.id).order_by(Subject.created_at.desc())
    subjects = db.scalars(stmt).all()

    out: list[SubjectOut] = []
    for s in subjects:
        cnt = (
            db.query(func.count(ErrorItem.id))
            .filter(ErrorItem.subject_id == s.id, ErrorItem.user_id == user.id)
            .scalar()
            or 0
        )
        out.append(SubjectOut(id=s.id, name=s.name, error_count=cnt))
    return out


# ---------- 创建 ----------
@router.post("", response_model=SubjectOut, status_code=status.HTTP_201_CREATED)
def create_notebook(
    payload: SubjectCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SubjectOut:
    existing = (
        db.query(Subject)
        .filter(Subject.user_id == user.id, Subject.name == payload.name)
        .first()
    )
    if existing:
        raise HTTPException(status_code=400, detail="Notebook name already exists")

    s = Subject(id=_uid(), name=payload.name, user_id=user.id)
    db.add(s)
    db.commit()
    db.refresh(s)
    return SubjectOut(id=s.id, name=s.name, error_count=0)


# ---------- 详情 ----------
@router.get("/{subject_id}")
def get_notebook(
    subject_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    s = db.get(Subject, subject_id)
    if not s or s.user_id != user.id:
        raise HTTPException(status_code=404, detail="Notebook not found")
    cnt = (
        db.query(func.count(ErrorItem.id))
        .filter(ErrorItem.subject_id == s.id, ErrorItem.user_id == user.id)
        .scalar()
        or 0
    )
    return SubjectOut(id=s.id, name=s.name, error_count=cnt)


# ---------- 更新 ----------
@router.patch("/{subject_id}", response_model=SubjectOut)
def update_notebook(
    subject_id: str,
    payload: SubjectUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    s = db.get(Subject, subject_id)
    if not s or s.user_id != user.id:
        raise HTTPException(status_code=404, detail="Notebook not found")
    if payload.name:
        s.name = payload.name
    db.commit()
    db.refresh(s)
    cnt = (
        db.query(func.count(ErrorItem.id))
        .filter(ErrorItem.subject_id == s.id, ErrorItem.user_id == user.id)
        .scalar()
        or 0
    )
    return SubjectOut(id=s.id, name=s.name, error_count=cnt)


# ---------- 删除 ----------
@router.delete("/{subject_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_notebook(
    subject_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    s = db.get(Subject, subject_id)
    if not s or s.user_id != user.id:
        raise HTTPException(status_code=404, detail="Notebook not found")
    db.delete(s)
    db.commit()
