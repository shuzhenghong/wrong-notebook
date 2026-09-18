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
        await recognizeImageLocal(Buffer.alloc(8)); // 不同内容，避开结果缓存

        expect(mocks.mockCreate).toHaveBeenCalledTimes(1);
        expect(instance.detect).toHaveBeenCalledTimes(2);
    });

    it('结果缓存：相同图片 5 分钟内直接返回，不重复推理', async () => {
        const instance = { detect: vi.fn().mockResolvedValue([{ text: 'x', mean: 0.9 }]) };
        mocks.mockCreate.mockResolvedValue(instance);

        const { recognizeImageLocal } = await loadModule();
        const buf = Buffer.from('same-image-jpeg');
        const first = await recognizeImageLocal(buf);
        const second = await recognizeImageLocal(Buffer.from('same-image-jpeg'));

        expect(instance.detect).toHaveBeenCalledTimes(1);
        expect(second).toEqual(first);
    });

    it('结果缓存：容量上限 50，淘汰最旧条目后重新推理', async () => {
        const instance = { detect: vi.fn().mockResolvedValue([{ text: 'x', mean: 0.9 }]) };
        mocks.mockCreate.mockResolvedValue(instance);

        const { recognizeImageLocal } = await loadModule();
        const bufs = Array.from({ length: 51 }, (_, i) => Buffer.from([i]));
        for (const b of bufs) await recognizeImageLocal(b);
        expect(instance.detect).toHaveBeenCalledTimes(51);

        // 最旧的第 1 张被淘汰 → 再识别会重新推理；第 2 张仍在缓存
        await recognizeImageLocal(bufs[0]);
        await recognizeImageLocal(bufs[1]);
        expect(instance.detect).toHaveBeenCalledTimes(53);
    });

    it('warmupLocalOcr：静默完成预热，不抛错', async () => {
        const instance = { detect: vi.fn().mockResolvedValue([]) };
        mocks.mockCreate.mockResolvedValue(instance);

        const { warmupLocalOcr } = await loadModule();
        await expect(warmupLocalOcr()).resolves.toBeUndefined();
        expect(mocks.mockCreate).toHaveBeenCalledTimes(1);
        expect(instance.detect).toHaveBeenCalledTimes(1);
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
