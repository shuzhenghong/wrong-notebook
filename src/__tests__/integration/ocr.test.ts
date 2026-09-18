/**
 * /api/ocr API 集成测试
 * 本地 OCR 接口：鉴权、限流、图片输入校验（key 归属 / base64 magic-byte）、
 * 双引擎选择（默认内置引擎 / OCR_BASE_URL 配置时走 sidecar）与错误映射
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockGetCurrentUser: vi.fn(),
    mockRateLimit: vi.fn(),
    mockIsLocalOcrEnabled: vi.fn(),
    mockRecognizeImage: vi.fn(),
    mockRecognizeImageLocal: vi.fn(),
    mockReadImage: vi.fn(),
    mockDecodeValidatedImage: vi.fn(),
}));

vi.mock('@/lib/server-auth', () => ({
    getCurrentUser: mocks.mockGetCurrentUser,
}));

vi.mock('@/lib/rate-limit', () => ({
    rateLimit: mocks.mockRateLimit,
}));

// 保留 OcrError 真实实现，仅 mock 两个引擎入口
vi.mock('@/lib/ocr', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/ocr')>();
    return {
        ...actual,
        isLocalOcrEnabled: mocks.mockIsLocalOcrEnabled,
        recognizeImage: mocks.mockRecognizeImage,
    };
});

vi.mock('@/lib/ocr-local', () => ({
    recognizeImageLocal: mocks.mockRecognizeImageLocal,
}));

vi.mock('@/lib/image-storage', () => ({
    readImage: mocks.mockReadImage,
    decodeValidatedImage: mocks.mockDecodeValidatedImage,
}));

import { POST } from '@/app/api/ocr/route';
import { unauthorized } from '@/lib/api-errors';
import { OcrError } from '@/lib/ocr';

const AUTHED_USER = {
    id: 'user-1',
    email: 'user@example.com',
    name: 'Test User',
    role: 'user',
    isActive: true,
    mustChangePassword: false,
};

function makeRequest(body: unknown) {
    return new Request('http://localhost/api/ocr', {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

// 12 字节、带 PNG 文件头的有效载荷（通过 magic-byte 校验）
const VALID_IMAGE_B64 = 'iVBORw0KGgoAAAAB';

describe('/api/ocr', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mockGetCurrentUser.mockResolvedValue({ ok: true, user: AUTHED_USER });
        mocks.mockRateLimit.mockReturnValue({ ok: true, retryAfterSeconds: 60 });
        // 默认未配置 OCR_BASE_URL：走内置引擎
        mocks.mockIsLocalOcrEnabled.mockReturnValue(false);
        mocks.mockRecognizeImageLocal.mockResolvedValue({
            text: '题目文本',
            lines: [{ text: '题目文本', score: 0.95 }],
            requestId: null,
        });
        mocks.mockRecognizeImage.mockResolvedValue({
            text: 'sidecar 文本',
            lines: [{ text: 'sidecar 文本', score: 0.9 }],
            requestId: 'req-sidecar',
        });
    });

    it('未登录返回 401', async () => {
        mocks.mockGetCurrentUser.mockResolvedValueOnce({ ok: false, response: unauthorized('Authentication required') });
        const res = await POST(makeRequest({ imageBase64: VALID_IMAGE_B64 }));
        expect(res.status).toBe(401);
    });

    it('限流时返回 429', async () => {
        mocks.mockRateLimit.mockReturnValueOnce({ ok: false, retryAfterSeconds: 30 });
        const res = await POST(makeRequest({ imageBase64: VALID_IMAGE_B64 }));
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBe('30');
    });

    it('缺少 key 与 imageBase64 时返回 400', async () => {
        const res = await POST(makeRequest({}));
        expect(res.status).toBe(400);
    });

    it('非法 JSON 返回 400', async () => {
        const res = await POST(new Request('http://localhost/api/ocr', {
            method: 'POST',
            body: 'not-json',
        }));
        expect(res.status).toBe(400);
    });

    it('key 含路径穿越时返回 400', async () => {
        const res = await POST(makeRequest({ key: '../etc/passwd' }));
        expect(res.status).toBe(400);
    });

    it('key 不属于当前用户时返回 403', async () => {
        const res = await POST(makeRequest({ key: 'other-user/item.jpg' }));
        expect(res.status).toBe(403);
    });

    it('key 图片不存在时返回 404', async () => {
        mocks.mockReadImage.mockReturnValueOnce(null);
        const res = await POST(makeRequest({ key: 'user-1/item.jpg' }));
        expect(res.status).toBe(404);
    });

    it('base64 未通过 magic-byte 校验时返回 400', async () => {
        mocks.mockDecodeValidatedImage.mockReturnValueOnce(null);
        const res = await POST(makeRequest({ imageBase64: VALID_IMAGE_B64 }));
        expect(res.status).toBe(400);
    });

    it('图片超过 8MB 上限时返回 400', async () => {
        const res = await POST(makeRequest({ imageBase64: 'A'.repeat(8 * 1024 * 1024 * 4) }));
        expect(res.status).toBe(400);
    });

    it('默认走内置引擎：base64 输入返回识别文本', async () => {
        mocks.mockDecodeValidatedImage.mockReturnValueOnce({ buffer: Buffer.alloc(12), mimeType: 'image/png' });
        const res = await POST(makeRequest({ imageBase64: VALID_IMAGE_B64 }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.text).toBe('题目文本');
        expect(body.lineCount).toBe(1);
        expect(body.requestId).toBeNull();
        expect(mocks.mockRecognizeImageLocal).toHaveBeenCalledWith(expect.any(Buffer));
        expect(mocks.mockRecognizeImage).not.toHaveBeenCalled();
    });

    it('配置 OCR_BASE_URL 时走 sidecar 引擎', async () => {
        mocks.mockIsLocalOcrEnabled.mockReturnValue(true);
        mocks.mockDecodeValidatedImage.mockReturnValueOnce({ buffer: Buffer.alloc(12), mimeType: 'image/png' });
        const res = await POST(makeRequest({ imageBase64: VALID_IMAGE_B64 }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.text).toBe('sidecar 文本');
        expect(body.requestId).toBe('req-sidecar');
        expect(mocks.mockRecognizeImage).toHaveBeenCalledWith(expect.any(Buffer), 'image/png');
        expect(mocks.mockRecognizeImageLocal).not.toHaveBeenCalled();
    });

    it('成功：key 输入读取落盘图片', async () => {
        mocks.mockReadImage.mockReturnValueOnce({ buffer: Buffer.alloc(12), mimeType: 'image/jpeg' });
        const res = await POST(makeRequest({ key: 'user-1/item.jpg' }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.text).toBe('题目文本');
        expect(mocks.mockReadImage).toHaveBeenCalledWith('user-1/item.jpg');
        expect(mocks.mockRecognizeImageLocal).toHaveBeenCalledWith(expect.any(Buffer));
    });

    it('内置引擎抛错（非 OcrError）兜底返回 502', async () => {
        mocks.mockDecodeValidatedImage.mockReturnValueOnce({ buffer: Buffer.alloc(12), mimeType: 'image/png' });
        mocks.mockRecognizeImageLocal.mockRejectedValueOnce(new Error('onnxruntime crashed'));
        const res = await POST(makeRequest({ imageBase64: VALID_IMAGE_B64 }));
        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body.message).toBe('OCR_UNAVAILABLE');
    });

    it('sidecar 模式下 OCR_BUSY 映射为 429', async () => {
        mocks.mockIsLocalOcrEnabled.mockReturnValue(true);
        mocks.mockDecodeValidatedImage.mockReturnValueOnce({ buffer: Buffer.alloc(12), mimeType: 'image/png' });
        mocks.mockRecognizeImage.mockRejectedValueOnce(new OcrError('OCR_BUSY'));
        const res = await POST(makeRequest({ imageBase64: VALID_IMAGE_B64 }));
        expect(res.status).toBe(429);
    });

    it('sidecar 模式下 OCR_TIMEOUT 映射为 504', async () => {
        mocks.mockIsLocalOcrEnabled.mockReturnValue(true);
        mocks.mockDecodeValidatedImage.mockReturnValueOnce({ buffer: Buffer.alloc(12), mimeType: 'image/png' });
        mocks.mockRecognizeImage.mockRejectedValueOnce(new OcrError('OCR_TIMEOUT'));
        const res = await POST(makeRequest({ imageBase64: VALID_IMAGE_B64 }));
        expect(res.status).toBe(504);
    });
});
