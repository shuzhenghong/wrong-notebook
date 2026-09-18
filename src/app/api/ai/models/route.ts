import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getAppConfig, getActiveOpenAIConfig } from '@/lib/config';
import { getCurrentUser } from '@/lib/server-auth';
import { badRequest } from '@/lib/api-errors';
import { validateBaseUrlWithDns } from '@/lib/ssrf';

const logger = createLogger('api:ai:models');

interface ModelInfo {
    id: string;
    name: string;
    owned_by?: string;
}

function extractModelName(modelId: string): string {
    return modelId.replace(/^models\//, '');
}

async function fetchGeminiModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    const url = `${baseUrl}/v1beta/models?key=${apiKey}`;

    const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, errorText }, 'Gemini models API error');
        throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    return (data.models || [])
        .map((m: any) => {
            const id = extractModelName(m.name);
            return {
                id,
                name: id,
                owned_by: 'Google',
            };
        });
}

async function fetchOpenAIModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    const url = `${baseUrl}/models`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        logger.error({ statusText: response.statusText }, 'OpenAI models API error');
        throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    return (data.data || [])
        .map((model: any) => ({
            id: model.id,
            name: model.id,
            owned_by: model.owned_by,
        }));
}

export async function GET(req: NextRequest) {
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    // 防御：绝对不能接受 URL query 里的 apiKey/baseUrl（SSRF + 密钥落日志）
    const { searchParams } = new URL(req.url);
    if (searchParams.has('apiKey') || searchParams.has('baseUrl')) {
        logger.warn({ path: req.nextUrl.pathname }, 'Rejected models fetch with apiKey/baseUrl in query');
        return badRequest('apiKey and baseUrl must be configured in settings, not passed via URL');
    }

    try {
        const provider = searchParams.get('provider');
        const config = getAppConfig();

        let apiKey: string | undefined;
        let baseUrl: string | undefined;

        if (provider === 'gemini') {
            apiKey = config.gemini?.apiKey;
            baseUrl = config.gemini?.baseUrl || 'https://generativelanguage.googleapis.com';
        } else if (provider === 'openai') {
            const active = getActiveOpenAIConfig();
            apiKey = active?.apiKey;
            baseUrl = active?.baseUrl || 'https://api.openai.com/v1';
        } else if (provider === 'azure') {
            apiKey = config.azure?.apiKey;
            baseUrl = config.azure?.endpoint;
        } else {
            return badRequest('provider must be one of: gemini, openai, azure');
        }

        if (!apiKey) {
            return badRequest('No API key configured for this provider');
        }

        // SSRF 最后一道闸门（理论上 settings POST 已校验，但防御式编程）。
        // 必须用带 DNS 解析的版本：静态黑名单拦不住"域名保存后被重指向内网"的重绑定
        if (baseUrl) {
            const vr = await validateBaseUrlWithDns(baseUrl);
            if (!vr.ok) {
                logger.warn({ baseUrl }, 'Configured baseUrl failed SSRF validation');
                return badRequest('Configured baseUrl rejected: ' + vr.reason);
            }
        }

        let models: ModelInfo[] = [];

        if (provider === 'gemini') {
            models = await fetchGeminiModels(apiKey, baseUrl!);
        } else {
            models = await fetchOpenAIModels(apiKey, baseUrl!);
        }

        return NextResponse.json({ models });

    } catch (error: any) {
        logger.error({ error }, 'Error fetching models');
        return NextResponse.json(
            { error: error.message || 'Internal server error', models: [] },
            { status: 200 }
        );
    }
}
