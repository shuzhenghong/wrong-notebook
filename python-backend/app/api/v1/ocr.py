"""POST /api/ocr — 本地 rapidocr-onnxruntime PP-OCRv4 中文识别."""

from __future__ import annotations

import hashlib
import os
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from ...models.user import User
from ...utils.dependencies import get_current_user
from ...utils.image_storage import decode_validated_image, read_image
from ...utils.rate_limiter import rate_limit
from ...utils.logger import get_logger

logger = get_logger("api:ocr")

router = APIRouter()

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_BASE64_CHARS = int(MAX_IMAGE_BYTES * 4 / 3)
OCR_RATE_LIMIT = 30
OCR_RATE_WINDOW_SEC = 60


class OcrRequest(BaseModel):
    key: str | None = Field(default=None, description="落盘图片 key, 如 <userId>/<errorItemId>.jpg")
    image_base64: str | None = Field(default=None, description="data URL 或裸 base64")

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class OcrLine(BaseModel):
    text: str
    score: float = 0.0


class OcrResponse(BaseModel):
    text: str
    lines: list[OcrLine] = Field(default_factory=list)
    line_count: int = 0
    request_id: str | None = None


# ---- 引擎单例 + 缓存 ----

_engine = None
_engine_lock = threading.Lock()

_cache: dict[str, tuple[float, OcrResponse]] = {}  # sha256 -> (expires_at, response)
_CACHE_MAX = 50
_CACHE_TTL = 300.0  # 5 min


def _get_engine():
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                from rapidocr_onnxruntime import RapidOCR
                _engine = RapidOCR()
    return _engine


def _cleanup_cache() -> None:
    now = time.time()
    expired = [k for k, (exp, _) in _cache.items() if exp < now]
    for k in expired:
        del _cache[k]
    # 超容量也删掉最旧的
    if len(_cache) > _CACHE_MAX:
        # 按过期时间排序, 删最老的
        items = sorted(_cache.items(), key=lambda kv: kv[1][0])
        for k, _ in items[: len(_cache) - _CACHE_MAX]:
            del _cache[k]


def _recognize(buf: bytes) -> OcrResponse:
    sha = hashlib.sha256(buf).hexdigest()
    now = time.time()
    if sha in _cache and _cache[sha][0] > now:
        return _cache[sha][1]

    try:
        engine = _get_engine()
        result, _ = engine(buf)
    except ImportError:
        raise HTTPException(status_code=503, detail="OCR engine not installed (rapidocr-onnxruntime)")
    except Exception as exc:  # noqa: BLE001
        logger.error("OCR engine error: %s", exc)
        raise HTTPException(status_code=502, detail=f"OCR engine error: {exc}")

    if not result:
        resp = OcrResponse(text="", lines=[], line_count=0, request_id=sha)
    else:
        lines = []
        text_parts = []
        for item in result:
            # rapidocr 返回: [[box[4], (text, score)], ...]
            try:
                text_val, score_val = item[1]
            except (IndexError, TypeError):
                continue
            lines.append(OcrLine(text=str(text_val), score=float(score_val)))
            text_parts.append(str(text_val))
        resp = OcrResponse(
            text="\n".join(text_parts),
            lines=lines,
            line_count=len(lines),
            request_id=sha,
        )

    _cleanup_cache()
    _cache[sha] = (now + _CACHE_TTL, resp)
    return resp


@router.post("", response_model=OcrResponse)
def ocr(
    body: OcrRequest,
    user: User = Depends(get_current_user),
) -> OcrResponse:
    ok, remaining, retry_after = rate_limit(f"ocr:{user.id}", OCR_RATE_LIMIT, OCR_RATE_WINDOW_SEC)
    if not ok:
        raise HTTPException(
            status_code=429,
            detail=f"OCR rate limit exceeded. Retry after {int(retry_after)}s.",
        )

    if body.key:
        # 落盘图片通路: 归属校验
        if ".." in body.key or body.key.startswith("/") or "\\" in body.key:
            raise HTTPException(status_code=400, detail="Invalid image key")
        if not body.key.startswith(f"{user.id}/"):
            raise HTTPException(status_code=403, detail="Not authorized to access this image")
        stored = read_image(body.key)
        if stored is None:
            raise HTTPException(status_code=404, detail="Image not found")
        buf, _mime = stored
    elif body.image_base64:
        if len(body.image_base64) > MAX_IMAGE_BASE64_CHARS:
            raise HTTPException(
                status_code=400,
                detail=f"Image too large (max {MAX_IMAGE_BYTES // 1024 // 1024}MB)",
            )
        decoded = decode_validated_image(body.image_base64)
        if decoded is None:
            raise HTTPException(status_code=400, detail="Invalid image data")
        buf, _mime = decoded
    else:
        raise HTTPException(status_code=400, detail="Provide either key or imageBase64")

    logger.info("OCR request userId=%s bytes=%d", user.id, len(buf))
    return _recognize(buf)
