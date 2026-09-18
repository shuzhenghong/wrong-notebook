/**
 * 本地 OCR 接口
 *
 * POST /api/ocr
 * Body（二选一）：
 *   - { key: "<userId>/<file>" }          读取已落盘图片（必须属于当前用户）
 *   - { imageBase64: "data:...|<base64>" } 直接上传图片（≤8MB，与 /api/analyze 同限）
 * 响应：{ text, lines: [{text, score}], lineCount, requestId }
 *
 * 依赖本地 OCR 服务（lw.PPOCR.OpenCVDNN）：通过 OCR_BASE_URL 启用，
 * 未配置时返回 503 OCR_NOT_CONFIGURED。
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server-auth";
import { rateLimit } from "@/lib/rate-limit";
import { badRequest, forbidden, notFound, tooManyRequests, createErrorResponse, ErrorCode, ErrorCodeType } from "@/lib/api-errors";
import { readImage, decodeValidatedImage } from "@/lib/image-storage";
import { recognizeImage, isLocalOcrEnabled, OcrError } from "@/lib/ocr";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:ocr');

// 与 /api/analyze 相同的图片体积上限：8MB（base64 按 4/3 折算）
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES * 4 / 3);

// OCR 是本地 CPU 推理，比 AI 便宜：每用户每分钟 30 次
const OCR_RATE_LIMIT = 30;
const OCR_RATE_WINDOW_MS = 60_000;

const OCR_STATUS_MAP: Record<OcrError['code'], { status: number; code: ErrorCodeType }> = {
    OCR_NOT_CONFIGURED: { status: 503, code: ErrorCode.OPERATION_NOT_ALLOWED },
    OCR_BUSY: { status: 429, code: ErrorCode.RATE_LIMITED },
    OCR_TIMEOUT: { status: 504, code: ErrorCode.AI_ERROR },
    OCR_UNAVAILABLE: { status: 502, code: ErrorCode.AI_ERROR },
    OCR_AUTH_FAILED: { status: 502, code: ErrorCode.AI_ERROR },
    OCR_BAD_REQUEST: { status: 400, code: ErrorCode.BAD_REQUEST },
    OCR_RESPONSE_ERROR: { status: 502, code: ErrorCode.AI_ERROR },
};

export async function POST(req: Request) {
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;
    const currentUser = auth.user;

    const limitResult = rateLimit(`ocr:${currentUser.id}`, OCR_RATE_LIMIT, OCR_RATE_WINDOW_MS);
    if (!limitResult.ok) {
        logger.warn({ userId: currentUser.id }, 'OCR rate limit exceeded');
        return tooManyRequests(limitResult.retryAfterSeconds);
    }

    if (!isLocalOcrEnabled()) {
        return createErrorResponse("OCR_NOT_CONFIGURED", 503, ErrorCode.OPERATION_NOT_ALLOWED);
    }

    let body: { key?: unknown; imageBase64?: unknown };
    try {
        body = await req.json();
    } catch {
        return badRequest("Invalid JSON body");
    }

    let buffer: Buffer;
    let mimeType = 'image/jpeg';

    if (typeof body.key === 'string' && body.key) {
        // 落盘图片通路：只接受当前用户自己的存储键（存储键第一层即 userId）
        if (body.key.includes('..') || body.key.startsWith('/') || body.key.includes('\\')) {
            return badRequest("Invalid image key");
        }
        if (!body.key.startsWith(`${currentUser.id}/`)) {
            return forbidden("Not authorized to access this image");
        }
        const stored = readImage(body.key);
        if (!stored) return notFound("Image not found");
        buffer = stored.buffer;
        mimeType = stored.mimeType;
    } else if (typeof body.imageBase64 === 'string' && body.imageBase64) {
        if (body.imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
            return badRequest(`Image too large (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`);
        }
        const decoded = decodeValidatedImage(body.imageBase64);
        if (!decoded) return badRequest("Invalid image data");
        buffer = decoded.buffer;
        mimeType = decoded.mimeType;
    } else {
        return badRequest("Provide either key or imageBase64");
    }

    try {
        const result = await recognizeImage(buffer, mimeType);
        logger.info({
            userId: currentUser.id,
            lineCount: result.lines.length,
            requestId: result.requestId,
        }, 'Local OCR completed');
        return NextResponse.json({
            text: result.text,
            lines: result.lines,
            lineCount: result.lines.length,
            requestId: result.requestId,
        });
    } catch (error: any) {
        if (error instanceof OcrError) {
            const mapped = OCR_STATUS_MAP[error.code];
            logger.warn({ userId: currentUser.id, code: error.code }, 'Local OCR failed');
            return createErrorResponse(error.code, mapped.status, mapped.code);
        }
        logger.error({ error: error?.message || String(error) }, 'Unexpected OCR error');
        return createErrorResponse("OCR_UNAVAILABLE", 502, ErrorCode.AI_ERROR);
    }
}
