import { NextResponse } from "next/server";
import { getMaskedAppConfig, getAppConfig, updateAppConfig } from "@/lib/config";
import { internalError, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { OpenAIInstance } from "@/types/api";
import { getCurrentUser } from "@/lib/server-auth";

const logger = createLogger('api:settings');

export const dynamic = 'force-dynamic';

export async function GET() {
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    // 返回掩码后的配置（apiKey 都是 ********）
    return NextResponse.json(getMaskedAppConfig());
}

export async function POST(req: Request) {
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    try {
        const body = await req.json();
        const currentConfig = getAppConfig();

        // Don't save masked keys if they somehow get sent back (for Gemini)
        if (body.gemini?.apiKey === '********') {
            body.gemini.apiKey = currentConfig.gemini?.apiKey;
        }

        // For OpenAI instances, preserve original keys for masked entries
        if (body.openai?.instances) {
            const currentInstances = currentConfig.openai?.instances || [];
            body.openai.instances = body.openai.instances.map((instance: OpenAIInstance) => {
                if (instance.apiKey === '********') {
                    const originalInstance = currentInstances.find((i: OpenAIInstance) => i.id === instance.id);
                    return {
                        ...instance,
                        apiKey: originalInstance?.apiKey || '',
                    };
                }
                return instance;
            });
        }

        // For Azure, preserve original key if masked
        if (body.azure?.apiKey === '********') {
            body.azure.apiKey = currentConfig.azure?.apiKey;
        }

        // updateAppConfig 内部已经做 SSRF 校验，抛错会在这里 catch
        updateAppConfig(body);
        // 返回掩码后的配置
        const masked = getMaskedAppConfig();
        return NextResponse.json(masked);
    } catch (error: any) {
        // SSRF 防护抛的异常 → 400
        if (error?.message?.startsWith('Refusing to save unsafe baseUrl')) {
            logger.warn({ error: error.message }, 'Rejected unsafe settings update');
            return badRequest('Unsafe baseUrl: ' + error.message);
        }
        logger.error({ error }, 'Failed to update settings');
        return internalError("Failed to update settings");
    }
}
