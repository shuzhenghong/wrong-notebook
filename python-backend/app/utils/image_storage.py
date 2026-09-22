"""错题图片落盘存储 — 对应 Next.js 版的 image-storage.ts.

按 userId 分目录存放, 数据库只存相对路径 (storage_key).
历史 base64 数据仍正常渲染 (只读兼容).
"""

from __future__ import annotations

import base64
import os
import re
from pathlib import Path

from ..config import get_settings


def get_images_root() -> Path:
    """图片存储根目录 — 跟随 upload_dir 配置, 下挂 images."""
    settings = get_settings()
    root = Path(settings.upload_dir).resolve() / "images"
    root.mkdir(parents=True, exist_ok=True)
    return root


# ---- magic-byte 检测 ----

_EXT_MAP: dict[str, str] = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}

_MIME_EXT: dict[str, str] = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
}


def _mime_from_ext(ext: str) -> str:
    return _EXT_MAP.get(ext.lower(), "image/jpeg")


def _ext_for_mime(mime: str) -> str:
    return _MIME_EXT.get(mime.lower(), "img")


def looks_like_real_image(buf: bytes) -> bool:
    """按 magic bytes 核实确实是常见图片格式."""
    if len(buf) < 12:
        return False
    if buf[0] == 0xFF and buf[1] == 0xD8 and buf[2] == 0xFF:
        return True  # JPEG
    if buf[:4] == b"\x89PNG":
        return True  # PNG
    if buf[:3] == b"GIF":
        return True  # GIF
    if buf[:2] == b"BM":
        return True  # BMP
    if buf[:4] == b"RIFF" and buf[8:12] == b"WEBP":
        return True  # WEBP
    return False


def decode_image(input_str: str) -> tuple[bytes, str] | None:
    """从 data URL 或裸 base64 拆出 (binary, mime)."""
    if not input_str or not isinstance(input_str, str):
        return None

    m = re.match(r"^data:([^;,]+)?(;[^,]*)?,(.*)$", input_str)
    if m:
        mime = m.group(1) or "image/jpeg"
        payload = m.group(3)
        if "base64" not in (m.group(2) or ""):
            return None
        try:
            return base64.b64decode(payload), mime
        except Exception:
            return None

    # 裸 base64
    if re.match(r"^[A-Za-z0-9+/=\s]+$", input_str) and len(input_str) >= 200:
        try:
            return base64.b64decode(input_str), "image/jpeg"
        except Exception:
            return None

    return None


def decode_validated_image(input_str: str) -> tuple[bytes, str] | None:
    decoded = decode_image(input_str)
    if not decoded or len(decoded[0]) == 0:
        return None
    if not looks_like_real_image(decoded[0]):
        return None
    return decoded


# ---- 读写 API ----

class StoredImage:
    def __init__(self, storage_key: str, mime_type: str, size: int):
        self.storage_key = storage_key
        self.mime_type = mime_type
        self.size = size
        self.url = f"/api/images/{storage_key}"


def store_image(user_id: str, error_item_id: str, input_str: str) -> StoredImage | None:
    """存一张图片到磁盘, 返回存储元数据; 失败返回 None."""
    decoded = decode_image(input_str)
    if not decoded or len(decoded[0]) == 0:
        return None
    buf, mime = decoded
    if not looks_like_real_image(buf):
        return None

    ext = _ext_for_mime(mime)
    storage_key = f"{user_id}/{error_item_id}.{ext}"
    target = get_images_root() / storage_key
    target.parent.mkdir(parents=True, exist_ok=True)

    try:
        target.write_bytes(buf)
        return StoredImage(storage_key, mime, len(buf))
    except OSError:
        return None


def read_image(storage_key: str) -> tuple[bytes, str] | None:
    """从磁盘读取一张图片, 返回 (binary, mime); 路径穿越或不存在返回 None."""
    if not storage_key or ".." in storage_key or storage_key.startswith("/") or "\\" in storage_key:
        return None

    target = (get_images_root() / storage_key).resolve()
    # 确保仍在 images_root 下 (防 symlink 逃逸)
    root = get_images_root().resolve()
    if not str(target).startswith(str(root) + os.sep) and target != root:
        return None

    try:
        buf = target.read_bytes()
        mime = _mime_from_ext(target.suffix)
        return buf, mime
    except OSError:
        return None


def delete_image(storage_key: str | None) -> None:
    if not storage_key or ".." in storage_key:
        return
    try:
        target = get_images_root() / storage_key
        target.unlink(missing_ok=True)
    except OSError:
        pass


def delete_user_images(user_id: str) -> None:
    if not user_id or ".." in user_id or "/" in user_id or "\\" in user_id:
        return
    import shutil
    try:
        shutil.rmtree(get_images_root() / user_id, ignore_errors=True)
    except OSError:
        pass


def is_inline_image(value: str | None) -> bool:
    if not value:
        return False
    return value.startswith("data:") or bool(re.match(r"^[A-Za-z0-9+/=]{200,}$", value))
