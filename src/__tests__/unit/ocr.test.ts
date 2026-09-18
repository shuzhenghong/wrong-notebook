/**
 * src/lib/ocr.ts 单元测试
 * 本地 OCR 客户端（lw.PPOCR.OpenCVDNN HTTP API v1）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockValidateBaseUrlWithDns: vi.fn(),
}));

vi.mock('@/lib/ssrf', () => ({
    validateBaseUrlWithDns: mocks.mockValidateBaseUrlWithDns,
}));

import { recognizeImage, isLocalOcrEnabled, getOcrBaseUrl, getOcrTimeoutMs, OcrError } from '@/lib/ocr';

const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAAB', 'base64');

function okResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('lib/ocr', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.OCR_BASE_URL;
        delete process.env.OCR_API_KEY;
        delete process.env.OCR_TIMEOUT_MS;
        mocks.mockValidateBaseUrlWithDns.mockResolvedValue({ ok: true });
    });

    afterEach(() => {
        process.env = { ...originalEnv };
        vi.unstubAllGlobals();
    });

    describe('配置解析', () => {
        it('未设置 OCR_BASE_URL 时功能关闭', () => {
            expect(isLocalOcrEnabled()).toBe(false);
            expect(getOcrBaseUrl()).toBeNull();
        });

        it('OCR_BASE_URL 去除尾部斜杠', () => {
            process.env.OCR_BASE_URL = 'http://127.0.0.1:8787/';
            expect(isLocalOcrEnabled()).toBe(true);
            expect(getOcrBaseUrl()).toBe('http://127.0.0.1:8787');
        });

        it('OCR_TIMEOUT_MS 非法值回落到默认 20000', () => {
            process.env.OCR_TIMEOUT_MS = 'abc';
            expect(getOcrTimeoutMs()).toBe(20000);
            process.env.OCR_TIMEOUT_MS = '100'; // 低于下限
            expect(getOcrTimeoutMs()).toBe(20000);
            process.env.OCR_TIMEOUT_MS = '5000';
            expect(getOcrTimeoutMs()).toBe(5000);
        });
    });

    describe('recognizeImage', () => {
        it('未配置时抛 OCR_NOT_CONFIGURED', async () => {
            await expect(recognizeImage(PNG_BYTES, 'image/png')).rejects.toMatchObject({
                code: 'OCR_NOT_CONFIGURED',
            });
        });

        it('baseUrl 不安全时抛 OCR_UNAVAILABLE 且不发起请求', async () => {
            process.env.OCR_BASE_URL = 'http://169.254.169.254:8787';
            mocks.mockValidateBaseUrlWithDns.mockResolvedValue({ ok: false, reason: 'private address' });
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);

            await expect(recognizeImage(PNG_BYTES, 'image/png')).rejects.toMatchObject({
                code: 'OCR_UNAVAILABLE',
            });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('成功：二进制直传并解析 result 数组', async () => {
            process.env.OCR_BASE_URL = 'http://127.0.0.1:8787';
            process.env.OCR_API_KEY = 'secret-key';
            const fetchMock = vi.fn().mockResolvedValue(okResponse({
                ok: true,
                request_id: 'req-1',
                result: [
                    { text: '第一行文字', score: 0.92, x1: 1, y1: 2, x2: 3, y2: 4, x3: 5, y3: 6, x4: 7, y4: 8 },
                    { text: '第二行文字' }, // 缺 score 字段
                ],
            }));
            vi.stubGlobal('fetch', fetchMock);

            const result = await recognizeImage(PNG_BYTES, 'image/png');

            expect(result.text).toBe('第一行文字\n第二行文字');
            expect(result.lines).toEqual([
                { text: '第一行文字', score: 0.92 },
                { text: '第二行文字', score: 0 },
            ]);
            expect(result.requestId).toBe('req-1');

            const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
            expect(init.method).toBe('POST');
            expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/png');
            expect((init.headers as Record<string, string>)['X-API-Key']).toBe('secret-key');
        });

        it('429 queue_full 映射为 OCR_BUSY', async () => {
            process.env.OCR_BASE_URL = 'http://127.0.0.1:8787';
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
                okResponse({ ok: false, error_code: 'queue_full', error: 'busy' }, 429)));

            await expect(recognizeImage(PNG_BYTES, 'image/png')).rejects.toMatchObject({
                code: 'OCR_BUSY',
            });
        });

        it('503 engine_wait_timeout 映射为 OCR_UNAVAILABLE', async () => {
            process.env.OCR_BASE_URL = 'http://127.0.0.1:8787';
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
                okResponse({ ok: false, error_code: 'engine_wait_timeout', error: 'timeout' }, 503)));

            await expect(recognizeImage(PNG_BYTES, 'image/png')).rejects.toMatchObject({
                code: 'OCR_UNAVAILABLE',
            });
        });

        it('401 unauthorized 映射为 OCR_AUTH_FAILED', async () => {
            process.env.OCR_BASE_URL = 'http://127.0.0.1:8787';
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
                okResponse({ ok: false, error_code: 'unauthorized', error: 'bad key' }, 401)));

            await expect(recognizeImage(PNG_BYTES, 'image/png')).rejects.toMatchObject({
                code: 'OCR_AUTH_FAILED',
            });
        });

        it('网络错误映射为 OCR_UNAVAILABLE', async () => {
            process.env.OCR_BASE_URL = 'http://127.0.0.1:8787';
            vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

            await expect(recognizeImage(PNG_BYTES, 'image/png')).rejects.toMatchObject({
                code: 'OCR_UNAVAILABLE',
            });
        });

        it('AbortError 映射为 OCR_TIMEOUT', async () => {
            process.env.OCR_BASE_URL = 'http://127.0.0.1:8787';
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

            await expect(recognizeImage(PNG_BYTES, 'image/png')).rejects.toMatchObject({
                code: 'OCR_TIMEOUT',
            });
        });

        it('ok!=true 或 result 非数组时抛 OCR_RESPONSE_ERROR', async () => {
            process.env.OCR_BASE_URL = 'http://127.0.0.1:8787';
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ ok: true, result: 'not-an-array' })));

            await expect(recognizeImage(PNG_BYTES, 'image/png')).rejects.toMatchObject({
                code: 'OCR_RESPONSE_ERROR',
            });
        });
    });

    it('OcrError 携带 code 且 message 即 code', () => {
        const err = new OcrError('OCR_BUSY');
        expect(err).toBeInstanceOf(OcrError);
        expect(err.code).toBe('OCR_BUSY');
        expect(err.message).toBe('OCR_BUSY');
    });
});
