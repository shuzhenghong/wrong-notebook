/**
 * 进程内令牌桶限流
 *
 * 单容器部署（本项目默认形态）足够用；多实例部署时请换成 Redis 等共享存储。
 * 目标是挡住误触与暴力调用：AI 分析、注册、日志上报等接口不能无限调用。
 *
 * 客户端 IP 取值策略（防伪造）：
 * - 优先 x-real-ip（通常由可信反代覆写，客户端无法污染）
 * - 其次 x-forwarded-for 取【最后一段】——每级代理会把"它看到的来源 IP"追加到链尾，
 *   链尾最接近服务端、最难被客户端伪造；取首段则可被任意伪造。
 * - 均缺失（直连无代理）时回退 'unknown'，所有直连用户共享同一个桶。
 */
interface Bucket {
    tokens: number;
    updatedAt: number;
}

const buckets = new Map<string, Bucket>();

// 防止 key 无限增长（例如伪造大量 IP）
const MAX_KEYS = 10000;
// 触发上限后一次性淘汰的比例
const EVICT_COUNT = Math.floor(MAX_KEYS * 0.1);

function sweepStale(now: number) {
    if (buckets.size <= MAX_KEYS) return;
    // 先清长时间未用的桶
    for (const [key, bucket] of buckets) {
        if (now - bucket.updatedAt > 60 * 60 * 1000) {
            buckets.delete(key);
        }
    }
    // 仍然超限：按插入顺序淘汰最旧的（Map 迭代顺序 = 插入顺序），
    // 而不是整体 clear() —— 整体清空会把正常用户的限流状态也一并抹掉
    let evicted = 0;
    for (const key of buckets.keys()) {
        buckets.delete(key);
        evicted++;
        if (evicted >= EVICT_COUNT || buckets.size < MAX_KEYS * 0.9) break;
    }
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
        // 触发限流也要刷新位置（LRU 触碰），避免活跃桶被误淘汰
        buckets.delete(key);
        buckets.set(key, { tokens, updatedAt: now });
        return {
            ok: false,
            remaining: 0,
            retryAfterSeconds: Math.ceil((1 - tokens) / refillPerMs / 1000),
        };
    }

    // 删除再插入 = 移到 Map 末尾，实现 LRU 触碰
    buckets.delete(key);
    buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return { ok: true, remaining: Math.floor(tokens - 1), retryAfterSeconds: 0 };
}

/** IPv4 / IPv6 的宽松格式校验，防止把任意字符串当 IP 写进限流键。 */
function looksLikeIp(value: string): boolean {
    if (!value || value.length > 45) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true; // IPv4
    if (/^[0-9a-fA-F:]+$/.test(value) && value.includes(':')) return true; // IPv6
    return false;
}

/**
 * 从请求头里取客户端 IP（防伪造版）。
 * 只在头部值看起来像合法 IP 时才采信，否则回退，避免任意字符串污染限流键。
 */
export function getClientIp(req: Request): string {
    const realIp = req.headers.get('x-real-ip');
    if (realIp) {
        const v = realIp.trim();
        if (looksLikeIp(v)) return v;
    }

    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) {
        const parts = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
        // 取链尾：最接近服务端的代理所记录的来源，最难被客户端伪造
        for (let i = parts.length - 1; i >= 0; i--) {
            if (looksLikeIp(parts[i])) return parts[i];
        }
    }

    return 'unknown';
}
