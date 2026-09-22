"""GET /api/images/{user_id}/{error_item_id}.jpg — 图片读取 + 归属校验."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, status
from fastapi.responses import Response

from ...models.user import User
from ...utils.dependencies import get_current_user
from ...utils.image_storage import read_image

router = APIRouter()


@router.get("/{key:path}")
def get_image(
    key: str = Path(..., description="存储键, 形如 <userId>/<errorItemId>.jpg"),
    user: User = Depends(get_current_user),
) -> Response:
    if not key:
        raise HTTPException(status_code=404, detail="Image not found")

    segments = key.split("/")
    owner_id = segments[0] if segments else ""

    if user.role != "admin" and owner_id != user.id:
        raise HTTPException(status_code=403, detail="Not authorized to access this image")

    result = read_image(key)
    if result is None:
        raise HTTPException(status_code=404, detail="Image not found")

    buf, mime = result
    return Response(
        content=buf,
        media_type=mime,
        headers={
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        },
    )
