/**
 * Models Route 单元测试
 *
 * 测试 /api/ai/models 端点的 Gemini 和 OpenAI 模型列表功能
 *
 * 注意：修复 P0 安全后，apiKey/baseUrl 不能再从 URL query 传入（SSRF + 密钥落日志），
 * 一律从 getAppConfig / getActiveOpenAIConfig 读取。单元测试 mock 这些依赖即可。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    // 默认返回已认证用户
    mockGetCurrentUser: vi.fn().mockResolvedValue({
        ok: true,
        user: { id: 'user-1', email: 'test@example.com', role: 'admin', isActive: true },
    }),
    // 默认返回 Gemini key + OpenAI active instance
    mockGetAppConfig: vi.fn().mockReturnValue({
        aiProvider: 'gemini',
        allowRegistration: true,
        openai: {
            instances: [{
                id: 'active-inst', name: 'Default',
                apiKey: 'sk-config-key',
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4o',
            }],
            activeInstanceId: 'active-inst',
        },
        gemini: { apiKey: 'AIza-config-key', baseUrl: '', model: 'gemini-2.5-flash' },
        azure: { apiKey: undefined, endpoint: undefined },
        prompts: {},
    }),
    mockGetActiveOpenAIConfig: vi.fn().mockReturnValue({
        id: 'active-inst', name: 'Default',
        apiKey: 'sk-config-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
    }),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
    createLogger: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        box: vi.fn(),
        divider: vi.fn(),
    })),
}));

// Mock auth + config（route 现在从这些取 apiKey，不再从 query 取）
vi.mock('@/lib/server-auth', () => ({
    getCurrentUser: mocks.mockGetCurrentUser,
}));
vi.mock('@/lib/config', () => ({
    getAppConfig: mocks.mockGetAppConfig,
    getActiveOpenAIConfig: mocks.mockGetActiveOpenAIConfig,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { GET } from '@/app/api/ai/models/route';

function makeRequest(params: Record<string, string>): NextRequest {
    const url = new URL('http://localhost/api/ai/models');
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }
    return new NextRequest(url);
}

describe('GET /api/ai/models - Gemini provider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('应该正确获取并返回 Gemini 视觉模型列表', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                models: [
                    { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
                    { name: 'models/gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' },
                    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
                ],
            }),
        });

        const req = makeRequest({ provider: 'gemini' });
        const res = await GET(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models).toHaveLength(3);
        expect(body.models[0]).toEqual({
            id: 'gemini-2.0-flash',
            name: 'gemini-2.0-flash',
            owned_by: 'Google',
        });
        expect(body.models[1].id).toBe('gemini-1.5-pro');
        expect(body.models[2].id).toBe('gemini-2.5-flash');

        // 验证调用的是从 config 读取的 key（不是 query 里的）
        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining('AIza-config-key'),
            expect.any(Object)
        );
    });

    it('应返回所有模型（不区分视觉/非视觉）', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                models: [
                    { name: 'models/gemini-2.0-flash' },
                    { name: 'models/text-embedding-004' },
                    { name: 'models/gemini-1.5-pro' },
                    { name: 'models/text-to-speech-01' },
                ],
            }),
        });

        const req = makeRequest({ provider: 'gemini' });
        const res = await GET(req);
        const body = await res.json();

        expect(body.models).toHaveLength(4);
        expect(body.models.map((m: any) => m.id)).toEqual([
            'gemini-2.0-flash',
            'text-embedding-004',
            'gemini-1.5-pro',
            'text-to-speech-01',
        ]);
    });

    it('API 返回空 models 数组时应返回空列表', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ models: [] }),
        });

        const req = makeRequest({ provider: 'gemini' });
        const res = await GET(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models).toEqual([]);
    });

    it('API 返回无 models 字段时应返回空列表', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({}),
        });

        const req = makeRequest({ provider: 'gemini' });
        const res = await GET(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models).toEqual([]);
    });

    it('Gemini API 返回错误时应返回 200 和空模型列表', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 403,
            text: async () => 'Forbidden',
        });

        const req = makeRequest({ provider: 'gemini' });
        const res = await GET(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models).toEqual([]);
        expect(body.error).toContain('Gemini API error');
    });

    it('配置里没有 apiKey 时应返回 400', async () => {
        mocks.mockGetAppConfig.mockReturnValueOnce({
            gemini: { apiKey: undefined },
            openai: { instances: [], activeInstanceId: undefined },
            azure: {},
        });

        const req = makeRequest({ provider: 'gemini' });
        const res = await GET(req);
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.message || body.error).toContain('API key');
    });

    it('query 里带 apiKey/baseUrl 应该被拒绝（SSRF 防护）', async () => {
        const req = makeRequest({ provider: 'gemini', apiKey: 'should-be-rejected', baseUrl: 'http://evil.example.com' });
        const res = await GET(req);

        expect(res.status).toBe(400);
    });

    it('未登录用户应返回 401', async () => {
        mocks.mockGetCurrentUser.mockResolvedValueOnce({
            ok: false,
            response: { status: 401, json: () => ({ message: 'Authentication required' }) },
        });

        const req = makeRequest({ provider: 'gemini' });
        const res = await GET(req);

        expect(res.status).toBe(401);
    });
});

describe('GET /api/ai/models - OpenAI provider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('应该正确获取并返回 OpenAI 视觉模型列表', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: [
                    { id: 'gpt-4o', owned_by: 'openai' },
                    { id: 'gpt-4-turbo', owned_by: 'openai' },
                    { id: 'text-embedding-3-small', owned_by: 'openai' },
                ],
            }),
        });

        const req = makeRequest({ provider: 'openai' });
        const res = await GET(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models).toHaveLength(3);
        expect(body.models[0].id).toBe('gpt-4o');
        expect(body.models[1].id).toBe('gpt-4-turbo');
        expect(body.models[2].id).toBe('text-embedding-3-small');
    });

    it('OpenAI API 返回错误时应返回 200 和空模型列表', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            statusText: 'Unauthorized',
            status: 401,
        });

        const req = makeRequest({ provider: 'openai' });
        const res = await GET(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models).toEqual([]);
        expect(body.error).toContain('API error');
    });
});
