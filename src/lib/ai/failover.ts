/**
 * AI 渠道自动降级（failover）
 *
 * 把多个 AI 渠道包装成有序候选列表：主渠道失败（连接/超时/限流/5xx/鉴权/输出异常）
 * 时自动尝试下一个渠道，全部失败抛出**最后一个**错误——保持与单渠道时代完全一致的
 * 错误码契约（AI_CONNECTION_FAILED / AI_TIMEOUT_ERROR / ...），路由层无需改动。
 *
 * 渠道来源（getAIServiceCandidates）：
 *   - openai：active 实例优先，其余已配置实例依次作为备选
 *   - gemini / azure：当前只有一个渠道，包装后行为与之前一致
 */
import type { AIService } from './types';
import { createLogger } from '../logger';

const logger = createLogger('ai:failover');

export interface AIProviderCandidate {
    /** 渠道展示名（日志用，不含密钥） */
    name: string;
    service: AIService;
    /** 出口 URL（供 SSRF 运行期校验，可能为空） */
    url?: string;
}

export class FailoverAIService implements AIService {    constructor(private readonly candidates: AIProviderCandidate[]) {
        if (!candidates || candidates.length === 0) {
            throw new Error('FailoverAIService requires at least one provider candidate');
        }
    }

    private async attempt<T>(method: keyof AIService, args: unknown[]): Promise<T> {
        let lastError: unknown;
        for (let i = 0; i < this.candidates.length; i++) {
            const candidate = this.candidates[i];
            try {
                const result = await (candidate.service[method] as (...a: unknown[]) => Promise<T>)(...args);
                if (i > 0) {
                    logger.info({ channel: candidate.name, method }, 'AI failover channel succeeded');
                }
                return result;
            } catch (error) {
                lastError = error;
                const isLast = i === this.candidates.length - 1;
                logger.warn(
                    {
                        channel: candidate.name,
                        method,
                        error: error instanceof Error ? error.message : String(error),
                        failover: !isLast,
                    },
                    isLast ? 'AI channel failed (no more candidates)' : 'AI channel failed, failing over to next channel'
                );
            }
        }
        throw lastError;
    }

    analyzeImage(...args: Parameters<AIService['analyzeImage']>): ReturnType<AIService['analyzeImage']> {
        return this.attempt('analyzeImage', args);
    }
    analyzeText(...args: Parameters<AIService['analyzeText']>): ReturnType<AIService['analyzeText']> {
        return this.attempt('analyzeText', args);
    }

    generateSimilarQuestion(...args: Parameters<AIService['generateSimilarQuestion']>): ReturnType<AIService['generateSimilarQuestion']> {
        return this.attempt('generateSimilarQuestion', args);
    }

    reanswerQuestion(...args: Parameters<AIService['reanswerQuestion']>): ReturnType<AIService['reanswerQuestion']> {
        return this.attempt('reanswerQuestion', args);
    }

    analyzeForGeogebra(...args: Parameters<AIService['analyzeForGeogebra']>): ReturnType<AIService['analyzeForGeogebra']> {
        return this.attempt('analyzeForGeogebra', args);
    }
}
