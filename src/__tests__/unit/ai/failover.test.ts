/**
 * src/lib/ai/failover.ts 单元测试
 * AI 渠道自动降级：主渠道失败切换下一个、全部失败抛最后错误、方法透传
 */
import { describe, it, expect, vi } from 'vitest';
import { FailoverAIService, type AIProviderCandidate } from '@/lib/ai/failover';
import type { AIService } from '@/lib/ai/types';

function makeCandidate(name: string, impl: Partial<AIService>): AIProviderCandidate {
    return { name, service: impl as AIService };
}

function makeParsedQuestion() {
    return { questionText: 'q', answerText: 'a', analysis: 'x', knowledgePoints: ['k'] };
}

describe('ai/failover', () => {
    it('主渠道成功：不触发降级，直接返回', async () => {
        const primary = { analyzeImage: vi.fn().mockResolvedValue(makeParsedQuestion()) };
        const backup = { analyzeImage: vi.fn() };
        const svc = new FailoverAIService([makeCandidate('p', primary), makeCandidate('b', backup)]);

        const result = await svc.analyzeImage('img', 'image/jpeg');

        expect(result).toEqual(makeParsedQuestion());
        expect(primary.analyzeImage).toHaveBeenCalledTimes(1);
        expect(backup.analyzeImage).not.toHaveBeenCalled();
    });

    it('主渠道失败：自动切换备选渠道并返回其结果', async () => {
        const primary = { analyzeImage: vi.fn().mockRejectedValue(new Error('AI_TIMEOUT_ERROR')) };
        const backup = { analyzeImage: vi.fn().mockResolvedValue(makeParsedQuestion()) };
        const svc = new FailoverAIService([makeCandidate('p', primary), makeCandidate('b', backup)]);

        const result = await svc.analyzeImage('img');

        expect(result).toEqual(makeParsedQuestion());
        expect(primary.analyzeImage).toHaveBeenCalledTimes(1);
        expect(backup.analyzeImage).toHaveBeenCalledTimes(1);
    });

    it('全部渠道失败：抛出最后一个渠道的错误（保持错误码契约）', async () => {
        const p1 = { analyzeImage: vi.fn().mockRejectedValue(new Error('AI_CONNECTION_FAILED')) };
        const p2 = { analyzeImage: vi.fn().mockRejectedValue(new Error('AI_TIMEOUT_ERROR')) };
        const svc = new FailoverAIService([makeCandidate('p1', p1), makeCandidate('p2', p2)]);

        await expect(svc.analyzeImage('img')).rejects.toThrow('AI_TIMEOUT_ERROR');
        expect(p1.analyzeImage).toHaveBeenCalledTimes(1);
        expect(p2.analyzeImage).toHaveBeenCalledTimes(1);
    });

    it('单渠道：行为与直接调用一致（gemini/azure 场景）', async () => {
        const only = { generateSimilarQuestion: vi.fn().mockResolvedValue(makeParsedQuestion()) };
        const svc = new FailoverAIService([makeCandidate('only', only)]);

        const result = await svc.generateSimilarQuestion('q', ['k']);

        expect(result).toEqual(makeParsedQuestion());
        expect(only.generateSimilarQuestion).toHaveBeenCalledWith('q', ['k']);
    });

    it('空候选列表：构造时直接抛错', () => {
        expect(() => new FailoverAIService([])).toThrow('at least one provider candidate');
    });

    it('四个接口方法都参与 failover', async () => {
        const p1 = {
            reanswerQuestion: vi.fn().mockRejectedValue(new Error('AI_SERVICE_UNAVAILABLE')),
            analyzeForGeogebra: vi.fn().mockRejectedValue(new Error('AI_CONNECTION_FAILED')),
        };
        const p2 = {
            reanswerQuestion: vi.fn().mockResolvedValue({ answerText: 'a' }),
            analyzeForGeogebra: vi.fn().mockResolvedValue({ suitable: false, commands: [] }),
        };
        const svc = new FailoverAIService([makeCandidate('p1', p1), makeCandidate('p2', p2)]);

        expect(await svc.reanswerQuestion('q')).toEqual({ answerText: 'a' });
        expect(await svc.analyzeForGeogebra('q', 'a', 'x')).toEqual({ suitable: false, commands: [] });
    });
});
