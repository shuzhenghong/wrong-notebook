"""multipart / JSON 双格式请求体解析 — 图片上传链路通用工具.

背景: 图片上传正从 base64 JSON 迁移到 multipart/form-data（体积省 33%）。
迁移期两类客户端并存（Web 前端走 multipart，mobile-app / 旧客户端走 JSON），
因此这几个图片端点需要同时接受两种格式。

约定:
  - multipart: 图片放 file 字段 "image"（兼容 "file"），其余字段为普通 form 字段
  - JSON: 图片放 "imageBase64"（data URL 或裸 base64）或 "imageDataUrl"
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field

from fastapi import Request

# 接受图片的 multipart file 字段名（按优先级）
_IMAGE_FILE_FIELDS = ("image", "file")
# 接受图片的 JSON 字段名（按优先级）
_IMAGE_JSON_FIELDS = ("imageBase64", "imageDataUrl", "image")


@dataclass
class ImageRequest:
    """解析结果: 图片 (统一为 data URL) + 其余标量字段."""

    image_data_url: str | None = None
    fields: dict[str, str] = field(default_factory=dict)

    def get(self, *names: str, default: str | None = None) -> str | None:
        """按优先级取第一个非空字段值."""
        for n in names:
            v = self.fields.get(n)
            if v not in (None, ""):
                return v
        return default


def _to_data_url(raw: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


async def parse_image_request(request: Request) -> ImageRequest:
    """按 content-type 解析 multipart 或 JSON 请求体.

    注意: JSON 分支兼容裸 base64（无 data: 前缀时默认按 jpeg 处理），
    与旧前端行为一致。
    """
    ctype = (request.headers.get("content-type") or "").lower()

    if ctype.startswith("multipart/"):
        form = await request.form()
        out = ImageRequest()
        for key, value in form.multi_items():
            if hasattr(value, "read"):  # UploadFile
                if key in _IMAGE_FILE_FIELDS and out.image_data_url is None:
                    data = await value.read()
                    if data:
                        mime = getattr(value, "content_type", None) or "image/jpeg"
                        out.image_data_url = _to_data_url(data, mime.split(";")[0])
                # 其余 file 字段忽略（当前链路只有单图）
            else:
                out.fields[key] = value if isinstance(value, str) else str(value)
        return out

    # JSON 分支
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - 空 body / 非 JSON
        body = {}
    if not isinstance(body, dict):
        body = {}

    fields: dict[str, str] = {}
    for k, v in body.items():
        if isinstance(v, (str, int, float, bool)):
            fields[k] = str(v)

    out = ImageRequest(fields=fields)
    for name in _IMAGE_JSON_FIELDS:
        img = body.get(name)
        if isinstance(img, str) and img:
            out.image_data_url = (
                img if img.startswith("data:") else f"data:image/jpeg;base64,{img}"
            )
            break
    return out
