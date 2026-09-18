import { NextResponse } from "next/server";
import { getMaskedAppConfig, getAppConfig, updateAppConfig, validateBaseUrlWithDns } from "@/lib/config";
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

        // 在写入之前再做一次带 DNS 解析的校验：
        // 防止域名解析到内网（字符串黑名单拦不住 DNS 重绑定）
        const dnsChecks: Array<{ label: string; url: string | undefined }> = [];
        if (body.openai?.instances) {
            for (const inst of body.openai.instances as OpenAIInstance[]) {
                dnsChecks.push({ label: `openai instance ${inst.name || inst.id}`, url: inst.baseUrl });
            }
        }
        if (body.gemini?.baseUrl) dnsChecks.push({ label: 'gemini', url: body.gemini.baseUrl });
        if (body.azure?.endpoint) dnsChecks.push({ label: 'azure', url: body.azure.endpoint });

        for (const { label, url } of dnsChecks) {
            const res = await validateBaseUrlWithDns(url);
            if (!res.ok) {
                logger.warn({ label, reason: res.reason }, 'Rejected unsafe baseUrl (dns check)');
                return badRequest(`Unsafe baseUrl for ${label}: ${res.reason}`);
            }
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
