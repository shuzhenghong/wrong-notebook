import { NextResponse } from "next/server";
import { notFound, forbidden } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getCurrentUser } from "@/lib/server-auth";
import { readImage } from "@/lib/image-storage";

const logger = createLogger('api:images');

export const runtime = 'nodejs';

/**
 * GET /api/images/<userId>/<errorItemId>.jpg
 *
 * 图片不再以 base64 存在数据库里，而是落盘后按用户分目录存放。
 * 这里按 key 的第一段（userId）做归属校验，避免越权读取他人图片。
 */
export async function GET(
    req: Request,
    { params }: { params: Promise<{ key: string[] }> }
) {
    const { key } = await params;

    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    const segments = Array.isArray(key) ? key : [];
    if (segments.length === 0) return notFound("Image not found");

    const ownerId = segments[0];
    if (auth.user.role !== 'admin' && ownerId !== auth.user.id) {
        logger.warn({ userId: auth.user.id, ownerId }, 'Forbidden image access attempt');
        return forbidden("Not authorized to access this image");
    }

    const image = readImage(segments.join('/'));
    if (!image) return notFound("Image not found");

    return new NextResponse(new Uint8Array(image.buffer), {
        headers: {
            'Content-Type': image.mimeType,
            'Cache-Control': 'private, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}
