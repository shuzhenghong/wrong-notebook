/**
 * 本地 OCR 客户端（对接 lw.PPOCR.OpenCVDNN HTTP 服务）
 *
 * 参考项目：https://github.com/lxw112190/lw.PPOCR.OpenCVDNN
 * （PP-OCRv6 Tiny Chinese，OpenCV 5 DNN CPU 推理，HTTP API v1 契约已冻结）
 *
 * 部署形态：
 *   - Docker Compose sidecar：ghcr.io/lxw112190/lw.ppocr.opencvdnn:1.1.0（默认 http://ocr:8787）
 *   - 独立部署：发布包内 ./lw-ppocr-http-service（默认 http://127.0.0.1:8787）
 *
 * 配置（环境变量）：
 *   - OCR_BASE_URL    OCR 服务地址。未设置 = 本地 OCR 功能关闭（isLocalOcrEnabled() === false）
 *   - OCR_API_KEY     可选，服务端启用 api_key 时必填，随 X-API-Key 头发送
 *   - OCR_TIMEOUT_MS  单次请求超时，默认 20000ms，允许 1000~120000
 *
 * 错误约定：所有失败抛 OcrError，code 与前端翻译键一一对应（t.errors[code]），
 * 与 AI 错误（AI_CONNECTION_FAILED 等）的处理方式保持一致。
 */
import { createLogger } from './logger';
import { validateBaseUrlWithDns } from './ssrf';

const logger = createLogger('ocr');

export type OcrErrorCode =
    | 'OCR_NOT_CONFIGURED'
    | 'OCR_UNAVAILABLE'
    | 'OCR_BUSY'
    | 'OCR_TIMEOUT'
    | 'OCR_AUTH_FAILED'
    | 'OCR_BAD_REQUEST'
    | 'OCR_RESPONSE_ERROR';

export class OcrError extends Error {
    constructor(public readonly code: OcrErrorCode, message?: string) {
        super(code);
        this.name = 'OcrError';
    }
}

/** OCR 服务地址（去除尾部斜杠）。未配置时返回 null。 */
export function getOcrBaseUrl(): string | null {
    const raw = (process.env.OCR_BASE_URL || '').trim();
    if (!raw) return null;
    return raw.replace(/\/+$/, '');
}

/** 本地 OCR 功能开关：显式配置 OCR_BASE_URL 才启用。 */
export function isLocalOcrEnabled(): boolean {
    return getOcrBaseUrl() !== null;
}

export function getOcrTimeoutMs(): number {
    const n = Number(process.env.OCR_TIMEOUT_MS);
    if (Number.isFinite(n) && n >= 1000 && n <= 120_000) return Math.floor(n);
    return 20_000;
}

export interface OcrLine {
    text: string;
    /** 识别置信度 0~1 */
    score: number;
}

export interface OcrResult {
    /** 按阅读顺序拼接的全部文本（每个区域一行） */
    text: string;
    lines: OcrLine[];
    /** OCR 服务返回的请求 ID，可用于在 OCR 服务日志中定位请求 */
    requestId: string | null;
}

/** HTTP API v1 错误码 → 本系统错误码映射（依据 docs/HTTP-API.md 状态码表） */
function mapHttpStatus(status: number, errorCode: string | null): OcrError {
    if (status === 401 || errorCode === 'unauthorized') {
        return new OcrError('OCR_AUTH_FAILED');
    }
    if (status === 429 || errorCode === 'queue_full') {
        return new OcrError('OCR_BUSY');
    }
    if (status === 413 || errorCode === 'payload_too_large') {
        return new OcrError('OCR_BAD_REQUEST');
    }
    if (status === 503 || errorCode === 'engine_wait_timeout' || errorCode === 'service_stopping' || errorCode === 'service_unavailable') {
        return new OcrError('OCR_UNAVAILABLE');
    }
    return new OcrError('OCR_UNAVAILABLE');
}

/**
 * 对一张编码图片（JPEG/PNG/BMP 等）执行完整 OCR（检测 + 方向分类 + 识别）。
 * 使用二进制直传（避免 Base64 约 33% 的体积膨胀），对应 POST /api/ocr。
 */
export async function recognizeImage(buffer: Buffer, mimeType: string): Promise<OcrResult> {
    const baseUrl = getOcrBaseUrl();
    if (!baseUrl) {
        throw new OcrError('OCR_NOT_CONFIGURED');
    }

    // 运行期再校验一次 OCR 服务地址：环境变量可能被手工改成内网/元数据地址（与 AI 出口校验同源）
    const check = await validateBaseUrlWithDns(baseUrl);
    if (!check.ok) {
        logger.error({ reason: check.reason }, 'Refusing to call OCR service with unsafe baseUrl');
        throw new OcrError('OCR_UNAVAILABLE');
    }

    const apiKey = (process.env.OCR_API_KEY || '').trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), getOcrTimeoutMs());

    let response: Response;
    try {
        response = await fetch(`${baseUrl}/api/ocr`, {
            method: 'POST',
            headers: {
                'Content-Type': mimeType || 'image/jpeg',
                ...(apiKey ? { 'X-API-Key': apiKey } : {}),
            },
            body: new Uint8Array(buffer),
            signal: controller.signal,
        });
    } catch (error: any) {
        if (error?.name === 'AbortError') {
            logger.warn({ baseUrl, timeoutMs: getOcrTimeoutMs() }, 'Local OCR request timed out');
            throw new OcrError('OCR_TIMEOUT');
        }
        logger.error({ error: error?.message || String(error) }, 'Local OCR service unreachable');
        throw new OcrError('OCR_UNAVAILABLE');
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        const body = await response.json().catch(() => null);
        const errorCode = typeof body?.error_code === 'string' ? body.error_code : null;
        // 依据 HTTP API v1：以稳定 error_code 为准，不解析可读 error 文本
        logger.warn({ status: response.status, errorCode }, 'Local OCR request failed');
        throw mapHttpStatus(response.status, errorCode);
    }

    let data: any;
    try {
        data = await response.json();
    } catch {
        throw new OcrError('OCR_RESPONSE_ERROR');
    }

    if (data?.ok !== true || !Array.isArray(data.result)) {
        throw new OcrError('OCR_RESPONSE_ERROR');
    }

    const lines: OcrLine[] = data.result
        .filter((item: any) => item && typeof item.text === 'string')
        .map((item: any) => ({
            text: item.text,
            score: typeof item.score === 'number' ? item.score : 0,
        }));

    return {
        text: lines.map((l) => l.text).join('\n'),
        lines,
        requestId: typeof data.request_id === 'string' ? data.request_id : null,
    };
}
