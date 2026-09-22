"""POST /api/openclaw/batch-upload — OpenClaw 外部 AI 批量上传 + 自动入库.

保留原始语义: 支持 apikey 或 credentials 两种认证模式, 批量调用 OpenClaw 识别服务.
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ...database import SessionLocal
from ...models.error_item import ErrorItem, Subject
from ...models.knowledge_tag import KnowledgeTag
from ...models.user import User
from ...utils.auth import verify_password
from ...utils.image_storage import decode_validated_image
from ...utils.logger import get_logger

logger = get_logger("api:openclaw:batch-upload")

router = APIRouter()

MAX_IMAGES = 20
MAX_IMAGE_SIZE = 5 * 1024 * 1024
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png"}


class ImageData(BaseModel):
    base64: str
    mime_type: str | None = None
    filename: str = ""

    model_config = {"populate_by_name": True}


class BatchUploadRequest(BaseModel):
    images: list[ImageData]
    subject_id: str | None = None
    username: str | None = None
    password: str | None = None
    user_email: str | None = None

    model_config = {"populate_by_name": True}


class BatchUploadResult(BaseModel):
    success: bool
    index: int
    error_item_id: str | None = None
    error: str | None = None

    model_config = {"populate_by_name": True}


class BatchUploadResponse(BaseModel):
    success: bool
    total: int
    success_count: int
    fail_count: int
    results: list[BatchUploadResult]


def _validate_image(base64: str, filename: str) -> tuple[bool, str | None]:
    if not base64:
        return False, "图片数据为空"
    ext = filename.lower().rsplit(".", 1)[-1]
    if "." + ext not in ALLOWED_EXTENSIONS:
        return False, f"不支持的图片格式: .{ext}"
    estimated_size = len(base64) * 3 / 4
    if estimated_size > MAX_IMAGE_SIZE:
        return False, f"图片大小超过限制: {estimated_size / 1024 / 1024:.1f}MB > 5MB"
    return True, None


async def _call_openclaw(image_base64: str, mime_type: str, timeout: float) -> dict[str, Any]:
    openclaw_url = os.environ.get("OPENCLAW_API_URL", "http://localhost:8080").rstrip("/")
    api_key = os.environ.get("OPENCLAW_API_KEY", "")

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.post(
                f"{openclaw_url}/api/recognize",
                json={"image": image_base64, "mimeType": mime_type},
                headers=headers,
            )
            if resp.status_code >= 400:
                logger.error("OpenClaw HTTP %s: %s", resp.status_code, resp.text[:200])
                return {"success": False, "error": f"识别服务异常: HTTP {resp.status_code}"}
            data = resp.json()
            return {"success": True, "data": data}
        except httpx.TimeoutException:
            logger.error("OpenClaw timeout")
            return {"success": False, "error": "识别服务超时"}
        except Exception as exc:  # noqa: BLE001
            logger.error("OpenClaw request failed: %s", exc)
            return {"success": False, "error": f"识别服务请求失败: {exc}"}


def _ensure_tag(db, name: str, user_id: str, subject_key: str) -> KnowledgeTag:
    tag = (
        db.query(KnowledgeTag)
        .filter(
            KnowledgeTag.name == name,
            (KnowledgeTag.is_system.is_(True)) | (KnowledgeTag.user_id == user_id),
        )
        .first()
    )
    if tag:
        return tag
    tag = KnowledgeTag(
        id=os.urandom(16).hex(),
        name=name,
        subject=subject_key,
        is_system=False,
        user_id=user_id,
    )
    db.add(tag)
    db.flush()
    return tag


def _create_error_item(
    db,
    user_id: str,
    subject_id: str | None,
    image_base64: str,
    mime_type: str,
    parsed: dict[str, Any],
) -> ErrorItem:
    question_text = parsed.get("questionText") or parsed.get("question")
    answer_text = parsed.get("answerText") or parsed.get("answer")
    analysis = parsed.get("analysis")
    knowledge_points = parsed.get("knowledgePoints") or parsed.get("knowledge_tags") or []
    subject_key = (parsed.get("subject") or "other").lower()

    tags: list[KnowledgeTag] = []
    if isinstance(knowledge_points, list):
        for kp in knowledge_points:
            if isinstance(kp, str) and kp.strip():
                try:
                    tags.append(_ensure_tag(db, kp.strip(), user_id, subject_key))
                except Exception as exc:  # noqa: BLE001
                    logger.error("Tag error: %s", exc)

    item = ErrorItem(
        id=os.urandom(16).hex(),
        user_id=user_id,
        subject_id=subject_id,
        original_image_url=f"data:{mime_type};base64,{image_base64}",
        question_text=question_text,
        answer_text=answer_text,
        analysis=analysis,
        knowledge_points=json.dumps(knowledge_points) if knowledge_points else None,
        source=parsed.get("source") or "OpenClaw",
        error_type=parsed.get("errorType"),
        mastery_level=0,
    )
    item.tags = tags
    db.add(item)
    db.flush()
    return item


@router.post("", response_model=BatchUploadResponse)
async def batch_upload(
    request: Request,
    body: BatchUploadRequest,
) -> BatchUploadResponse:
    import json as _json

    # ---- 认证 ----
    auth_mode = os.environ.get("OPENCLAW_AUTH_MODE", "credentials")
    expected_api_key = os.environ.get("OPENCLAW_INTEGRATION_API_KEY", "")

    db = SessionLocal()
    try:
        if auth_mode == "apikey" and expected_api_key:
            api_key = request.headers.get("x-api-key")
            if not api_key or api_key != expected_api_key:
                raise HTTPException(status_code=401, detail="Invalid API key")
            user_email = body.user_email
            if not user_email:
                raise HTTPException(status_code=400, detail="userEmail required in apikey mode")
            user = db.query(User).filter(User.email == user_email).first()
        else:
            # credentials 模式
            if not body.username or not body.password:
                raise HTTPException(status_code=401, detail="Missing username or password")
            user = (
                db.query(User)
                .filter((User.email == body.username) | (User.name == body.username))
                .first()
            )
            if not user or not verify_password(body.password, user.password):
                raise HTTPException(status_code=401, detail="Invalid credentials")
            if not user.is_active:
                raise HTTPException(status_code=401, detail="Account disabled")

        assert user is not None

        if not body.images:
            raise HTTPException(status_code=400, detail="Missing images array")
        if len(body.images) > MAX_IMAGES:
            raise HTTPException(status_code=400, detail=f"最多 {MAX_IMAGES} 张")

        timeout = int(os.environ.get("OPENCLAW_TIMEOUT", "30000")) / 1000.0
        per_image_timeout = min(3.0, timeout / len(body.images)) if body.images else timeout

        results: list[BatchUploadResult] = []
        for i, img in enumerate(body.images):
            ok, err = _validate_image(img.base64, img.filename or f"img_{i}.png")
            if not ok:
                results.append(BatchUploadResult(success=False, index=i, error=err))
                continue

            mime = img.mime_type or "image/png"
            openclaw_resp = await _call_openclaw(img.base64, mime, per_image_timeout)
            if not openclaw_resp.get("success"):
                results.append(
                    BatchUploadResult(success=False, index=i, error=openclaw_resp.get("error", "识别失败"))
                )
                continue

            try:
                item = _create_error_item(
                    db, user.id, body.subject_id, img.base64, mime, openclaw_resp.get("data", {})
                )
                results.append(BatchUploadResult(success=True, index=i, error_item_id=item.id))
            except Exception as exc:  # noqa: BLE001
                logger.error("Batch DB error: %s", exc)
                results.append(
                    BatchUploadResult(success=False, index=i, error=f"数据库写入失败: {exc}")
                )

        db.commit()
        success_count = sum(1 for r in results if r.success)
        fail_count = len(results) - success_count
        status_code = 201 if fail_count == 0 else 207

        response = BatchUploadResponse(
            success=(fail_count == 0),
            total=len(results),
            success_count=success_count,
            fail_count=fail_count,
            results=results,
        )
        # FastAPI status_code override
        from fastapi.responses import JSONResponse
        return JSONResponse(content=response.model_dump(mode="camel"), status_code=status_code)
    finally:
        db.close()


# 引入 json (上面用 import json as _json, 这里直接引一次避免 NameError)
import json  # noqa: E402,F811
