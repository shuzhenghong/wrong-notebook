type RequestOptions = RequestInit & {
    params?: Record<string, string>;
    timeout?: number; // 超时时间（毫秒），默认 60000
};

export class ApiError extends Error {
    constructor(public status: number, public statusText: string, public data: unknown) {
        super(`API Error: ${status} ${statusText}`);
        this.name = 'ApiError';
    }
}

/**
 * Python 后端返回的是 FastAPI 形态的错误体 { detail: "..." }，
 * 而前端各处统一按 error.data.message 取后端错误码/文案。
 * 这里归一化一次，避免迁移后所有报错都退化成通用文案。
 */
function normalizeErrorData(raw: unknown): unknown {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const obj = raw as Record<string, unknown>;
        if (obj.message === undefined && typeof obj.detail === 'string') {
            return { ...obj, message: obj.detail };
        }
    }
    return raw;
}

async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const { params, headers, timeout = 60000, ...rest } = options;

    let finalUrl = url;
    if (params) {
        const searchParams = new URLSearchParams(params);
        finalUrl += `?${searchParams.toString()}`;
    }

    const defaultHeaders: HeadersInit = {
        'Content-Type': 'application/json',
    };

    // 创建 AbortController 用于超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const res = await fetch(finalUrl, {
            headers: {
                ...defaultHeaders,
                ...headers,
            },
            signal: controller.signal,
            ...rest,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            let errorData;
            try {
                errorData = await res.json();
            } catch {
                errorData = await res.text();
            }
            throw new ApiError(res.status, res.statusText, normalizeErrorData(errorData));
        }

        // Handle empty responses (e.g. 204 No Content)
        if (res.status === 204) {
            return {} as T;
        }

        try {
            return await res.json();
        } catch {
            // If JSON parse fails but response was OK, return text or empty object?
            // For now, assume JSON APIs.
            return {} as T;
        }
    } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
            throw new ApiError(408, 'Request Timeout', {
                message: 'AI_TIMEOUT_ERROR'
            });
        }
        throw error;
    }
}

export interface StreamCallbacks {
    /** SSE status 事件（如 calling_ai） */
    onStatus?: (stage: string) => void;
    /** AI 增量文本 */
    onDelta?: (text: string) => void;
}

/**
 * SSE 流式 POST：服务端分阶段推送 status/delta，最终以 result 事件返回完整 JSON。
 * 错误时抛 ApiError（data.message 为归一化错误码），与普通 post 的错误处理一致。
 */
async function postStream<TResponse>(url: string, body: unknown, callbacks: StreamCallbacks = {}, options: RequestOptions = {}): Promise<TResponse> {
    const { timeout = 180000 } = options;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!res.ok || !res.body) {
            let errorData: unknown;
            try {
                errorData = await res.json();
            } catch {
                errorData = await res.text();
            }
            throw new ApiError(res.status, res.statusText, normalizeErrorData(errorData));
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let result: TResponse | null = null;
        let streamError: { message: string } | null = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const frames = buffer.split('\n\n');
            buffer = frames.pop() ?? '';
            for (const frame of frames) {
                let event = 'message';
                const dataLines: string[] = [];
                for (const line of frame.split('\n')) {
                    if (line.startsWith('event:')) event = line.slice(6).trim();
                    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
                }
                if (dataLines.length === 0) continue;
                let payload: any;
                try {
                    payload = JSON.parse(dataLines.join('\n'));
                } catch {
                    continue;
                }
                if (event === 'status') callbacks.onStatus?.(payload.stage);
                else if (event === 'delta') callbacks.onDelta?.(payload.text);
                else if (event === 'result') result = payload as TResponse;
                else if (event === 'error') streamError = payload;
            }
        }

        if (streamError) {
            // 与非流式路径同构：404 data.message 承载错误码，前端映射文案
            throw new ApiError(500, 'Stream Error', { message: streamError.message });
        }
        if (result === null) {
            throw new ApiError(502, 'Stream Error', { message: 'AI_RESPONSE_ERROR' });
        }
        return result;
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new ApiError(408, 'Request Timeout', { message: 'AI_TIMEOUT_ERROR' });
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

export const apiClient = {
    get: <T>(url: string, options?: RequestOptions) => request<T>(url, { ...options, method: 'GET' }),
    post: <TResponse, TBody = any>(url: string, body: TBody, options?: RequestOptions) => request<TResponse>(url, { ...options, method: 'POST', body: JSON.stringify(body) }),
    postStream: <TResponse, TBody = any>(url: string, body: TBody, callbacks?: StreamCallbacks, options?: RequestOptions) => postStream<TResponse>(url, body, callbacks, options),
    put: <TResponse, TBody = any>(url: string, body: TBody, options?: RequestOptions) => request<TResponse>(url, { ...options, method: 'PUT', body: JSON.stringify(body) }),
    patch: <TResponse, TBody = any>(url: string, body: TBody, options?: RequestOptions) => request<TResponse>(url, { ...options, method: 'PATCH', body: JSON.stringify(body) }),
    delete: <T>(url: string, options?: RequestOptions) => request<T>(url, { ...options, method: 'DELETE' }),
};
