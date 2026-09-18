/**
 * 进程内令牌桶限流
 *
 * 单容器部署（本项目默认形态）足够用；多实例部署时请换成 Redis 等共享存储。
 * 目标是挡住误触与暴力调用：AI 分析、注册、日志上报等接口不能无限调用。
 */
interface Bucket {
    tokens: number;
    updatedAt: number;
}

const buckets = new Map<string, Bucket>();

// 防止 key 无限增长（例如伪造大量 IP）
const MAX_KEYS = 10000;

function sweepStale(now: number) {
    if (buckets.size <= MAX_KEYS) return;
    for (const [key, bucket] of buckets) {
        if (now - bucket.updatedAt > 60 * 60 * 1000) {
            buckets.delete(key);
        }
    }
    // 仍然过大就整体重置，避免内存无上限增长
    if (buckets.size > MAX_KEYS) buckets.clear();
}

export interface RateLimitResult {
    ok: boolean;
    remaining: number;
    retryAfterSeconds: number;
}

/**
 * @param key 限流维度，如 `analyze:user:123` 或 `register:ip:1.2.3.4`
 * @param limit 窗口内允许的请求数
 * @param windowMs 窗口长度（毫秒）
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    sweepStale(now);

    const refillPerMs = limit / windowMs;
    const bucket = buckets.get(key) ?? { tokens: limit, updatedAt: now };

    const elapsed = Math.max(0, now - bucket.updatedAt);
    const tokens = Math.min(limit, bucket.tokens + elapsed * refillPerMs);

    if (tokens < 1) {
        buckets.set(key, { tokens, updatedAt: now });
        return {
            ok: false,
            remaining: 0,
            retryAfterSeconds: Math.ceil((1 - tokens) / refillPerMs / 1000),
        };
    }

    buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return { ok: true, remaining: Math.floor(tokens - 1), retryAfterSeconds: 0 };
}

/** 从请求头里取客户端 IP（兼容反代场景，只取第一个）。 */
export function getClientIp(req: Request): string {
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.headers.get('x-real-ip') || 'unknown';
}
