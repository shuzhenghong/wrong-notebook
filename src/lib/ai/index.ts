import { AIService } from "./types";
import { GeminiProvider } from "./gemini-provider";
import { OpenAIProvider } from "./openai-provider";
import { AzureOpenAIProvider } from "./azure-provider";
import { FailoverAIService, AIProviderCandidate } from "./failover";

export * from "./types";
export { FailoverAIService, type AIProviderCandidate } from "./failover";

import { getAppConfig, getActiveOpenAIConfig } from "../config";
import { createLogger } from "../logger";

const logger = createLogger('ai');

/**
 * 构建有序 AI 渠道候选列表（主渠道在前）。
 * - openai：active 实例优先，其余已配置实例依次作为降级备选
 * - gemini / azure：单渠道，行为与之前一致
 * 无 apiKey 的实例会被跳过（OpenAIProvider 构造会抛 AI_AUTH_ERROR）。
 */
export function getAIServiceCandidates(): AIProviderCandidate[] {
    // Always get fresh config
    const config = getAppConfig();
    const provider = config.aiProvider;
    const candidates: AIProviderCandidate[] = [];

    if (provider === "openai") {
        const activeConfig = getActiveOpenAIConfig();
        const instances = config.openai?.instances || [];
        // active 实例排最前，其余实例保持配置顺序作为备选
        const ordered = [
            ...instances.filter((i) => i.id === activeConfig?.id),
            ...instances.filter((i) => i.id !== activeConfig?.id),
        ];
        for (const instance of ordered) {
            if (!instance.apiKey) continue;
            candidates.push({
                name: `openai:${instance.name || instance.id}`,
                service: new OpenAIProvider(instance),
                url: instance.baseUrl,
            });
        }
        logger.info({ channels: candidates.map((c) => c.name) }, 'Using OpenAI Provider with failover chain');
    } else if (provider === "azure") {
        logger.info({ deployment: config.azure?.deploymentName }, 'Using Azure OpenAI Provider');
        candidates.push({
            name: 'azure',
            service: new AzureOpenAIProvider(config.azure),
            url: config.azure?.endpoint,
        });
    } else {
        logger.info('Using Gemini Provider');
        candidates.push({
            name: 'gemini',
            service: new GeminiProvider(config.gemini),
            url: config.gemini?.baseUrl,
        });
    }

    return candidates;
}

/** failover 包装后的 AI 服务（主渠道失败自动切下一个候选） */
export function getAIService(): AIService {
    return new FailoverAIService(getAIServiceCandidates());
}

/** 服务 + 候选列表一起返回，供调用方在发起请求前对全部候选渠道出口做 SSRF 校验 */
export function getAIServiceWithCandidates(): { service: AIService; candidates: AIProviderCandidate[] } {
    const candidates = getAIServiceCandidates();
    return { service: new FailoverAIService(candidates), candidates };
}
