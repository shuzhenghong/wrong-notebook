/**
 * src/lib/ocr-local.ts 单元测试
 * 进程内本地 OCR 引擎（@gutenye/ocr-node）封装：单例、结果映射、失败重试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockCreate: vi.fn(),
}));

vi.mock('@gutenye/ocr-node', () => ({
    default: { create: mocks.mockCreate },
}));

// 每个用例重新加载模块，隔离引擎单例状态
async function loadModule() {
    return await import('@/lib/ocr-local');
}

describe('lib/ocr-local', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('成功：映射 detect 结果为 OcrResult', async () => {
        const instance = {
            detect: vi.fn().mockResolvedValue([
                { text: '第一行', mean: 0.97, box: [[1, 2], [3, 4], [5, 6], [7, 8]] },
                { text: '第二行' }, // 缺 mean
            ]),
        };
        mocks.mockCreate.mockResolvedValue(instance);

        const { recognizeImageLocal } = await loadModule();
        const result = await recognizeImageLocal(Buffer.from('jpeg-bytes'));

        expect(result.text).toBe('第一行\n第二行');
        expect(result.lines).toEqual([
            { text: '第一行', score: 0.97 },
            { text: '第二行', score: 0 },
        ]);
        expect(result.requestId).toBeNull();
        // Buffer 以原始字节传给引擎
        const arg = instance.detect.mock.calls[0][0] as Uint8Array;
        expect(arg).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength).toString()).toBe('jpeg-bytes');
    });

    it('引擎单例：多次识别只 create 一次', async () => {
        const instance = { detect: vi.fn().mockResolvedValue([{ text: 'x', mean: 0.9 }]) };
        mocks.mockCreate.mockResolvedValue(instance);

        const { recognizeImageLocal } = await loadModule();
        await recognizeImageLocal(Buffer.alloc(4));
        await recognizeImageLocal(Buffer.alloc(4));

        expect(mocks.mockCreate).toHaveBeenCalledTimes(1);
        expect(instance.detect).toHaveBeenCalledTimes(2);
    });

    it('detect 返回 null 时得到空结果', async () => {
        mocks.mockCreate.mockResolvedValue({ detect: vi.fn().mockResolvedValue(null) });

        const { recognizeImageLocal } = await loadModule();
        const result = await recognizeImageLocal(Buffer.alloc(4));

        expect(result.text).toBe('');
        expect(result.lines).toEqual([]);
    });

    it('引擎加载失败时抛错，且下次请求会重试加载', async () => {
        mocks.mockCreate.mockRejectedValueOnce(new Error('model load failed'));
        const instance = { detect: vi.fn().mockResolvedValue([{ text: 'ok', mean: 0.9 }]) };
        mocks.mockCreate.mockResolvedValueOnce(instance).mockResolvedValue(instance);

        const { recognizeImageLocal } = await loadModule();
        await expect(recognizeImageLocal(Buffer.alloc(4))).rejects.toThrow('model load failed');

        // 第二次请求重新尝试 create
        const result = await recognizeImageLocal(Buffer.alloc(4));
        expect(result.text).toBe('ok');
        expect(mocks.mockCreate).toHaveBeenCalledTimes(2);
    });

    it('推理抛错时同样抛出（由路由层兜底 502）', async () => {
        const instance = { detect: vi.fn().mockRejectedValue(new Error('inference failed')) };
        mocks.mockCreate.mockResolvedValue(instance);

        const { recognizeImageLocal } = await loadModule();
        await expect(recognizeImageLocal(Buffer.alloc(4))).rejects.toThrow('inference failed');
    });
});
