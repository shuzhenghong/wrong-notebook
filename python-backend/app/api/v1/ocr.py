"""POST /api/ocr — 本地 rapidocr-onnxruntime PP-OCRv4 中文识别."""

from __future__ import annotations

import hashlib
import threading
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from ...models.user import User
from ...schemas.base import CamelModel
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


class OcrRequest(CamelModel):
    key: str | None = Field(default=None, description="落盘图片 key, 如 <userId>/<errorItemId>.jpg")
    image_base64: str | None = Field(default=None, description="data URL 或裸 base64")


class OcrLine(CamelModel):
    text: str
    score: float = 0.0


class OcrResponse(CamelModel):
    """对外响应 — 经 CamelModel 序列化为 camelCase (lineCount / requestId).

    前端 src/lib/ocr-client.ts 读取 data.lineCount / data.requestId,
    这里必须保持 camelCase, 否则字段会静默变成 undefined.
    """

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


def _build_engine():
    """装配 OCR 引擎（惰性单例）。

    优先级：
      1. rapidocr>=3.x —— rapidocr-onnxruntime 的官方后继版本，支持 Python 3.8~3.13
      2. rapidocr-onnxruntime —— 旧包，Requires-Python <3.13，仅作兜底

    两者对外类名一致（RapidOCR），无需分支处理调用方式。
    """
    try:
        from rapidocr import RapidOCR

        return RapidOCR()
    except ImportError as exc:
        first_error = exc
    try:
        from rapidocr_onnxruntime import RapidOCR

        return RapidOCR()
    except ImportError as exc:
        raise ImportError(
            f"no OCR engine available ({first_error}; {exc})"
        ) from exc


def _get_engine():
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                _engine = _build_engine()
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


def _extract_lines(raw: object) -> list[OcrLine]:
    """把不同 RapidOCR 版本的返回结构统一转成 OcrLine 列表.

    实测到的三种形态:
      rapidocr>=3.x        -> RapidOCROutput(.txts, .scores)，**不是元组，不能解包**
      rapidocr-onnxruntime -> [[box, text, score], ...]
      更早版本             -> [[box, (text, score)], ...]
    """
    lines: list[OcrLine] = []

    txts = getattr(raw, "txts", None)
    scores = getattr(raw, "scores", None)
    if txts is not None:
        for i, text_val in enumerate(txts):
            score_val = scores[i] if scores is not None and i < len(scores) else 0.0
            lines.append(OcrLine(text=str(text_val), score=float(score_val)))
        return lines

    for item in raw or []:
        try:
            second = item[1]
            if isinstance(second, (tuple, list)):
                text_val, score_val = second[0], second[1]
            else:
                text_val, score_val = second, item[2]
        except (IndexError, TypeError):
            continue
        lines.append(OcrLine(text=str(text_val), score=float(score_val)))
    return lines


def _recognize(buf: bytes, user_id: str) -> OcrResponse:
    # 缓存键加 user_id 前缀: 不同用户上传同一张图 (相同 sha256) 不会命中彼此的缓存,
    # 避免 OCR 结果 (可能含敏感题目信息) 跨用户泄漏.
    sha = hashlib.sha256(buf).hexdigest()
    cache_key = f"{user_id}:{sha}"
    now = time.time()
    if cache_key in _cache and _cache[cache_key][0] > now:
        return _cache[cache_key][1]

    try:
        engine = _get_engine()
        raw = engine(buf)
    except ImportError as exc:
        logger.warning("OCR engine missing: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="OCR_NOT_INSTALLED: pip install -r requirements-ocr.txt",
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("OCR engine error: %s", exc)
        raise HTTPException(status_code=502, detail=f"OCR engine error: {exc}")

    # 部分版本返回 (result, elapse) 元组，这里统一成 result 本体
    if isinstance(raw, tuple) and len(raw) == 2 and isinstance(raw[0], list):
        raw = raw[0]

    lines = _extract_lines(raw)
    if not lines:
        resp = OcrResponse(text="", lines=[], line_count=0, request_id=sha)
    else:
        resp = OcrResponse(
            text="\n".join(line.text for line in lines),
            lines=lines,
            line_count=len(lines),
            request_id=sha,
        )

    _cleanup_cache()
    _cache[cache_key] = (now + _CACHE_TTL, resp)
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
    return _recognize(buf, user.id)
