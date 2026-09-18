/**
 * 敏感字段掩码 / 日志脱敏
 */

/** 把一个密钥/Token 等敏感串做成 "sk-abc...xyz" 的样子。 */
export function maskSecret(value: string | null | undefined, keep: number = 4): string {
    if (!value) return "";
    if (value.length <= keep * 2) return "*".repeat(Math.max(value.length, 6));
    return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

/** 全掩码版本，给 settings GET 用。 */
export const FULL_MASK = "********";

/**
 * 深度扫描一个对象，把所有看起来像密钥的字段替换成 FULL_MASK。
 * - apiKey / api_key / apikey
 * - password / secret / token / bearer / client_secret / authorization / key
 */
const SENSITIVE_KEY_RE = /(api[_-]?key|apikey|password|secret|token|bearer|authorization|client[_-]?secret|\bkey\b)/i;

export function maskSensitiveFields<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== "object") return obj;

    if (Array.isArray(obj)) {
        return obj.map((item) => maskSensitiveFields(item)) as unknown as T;
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (SENSITIVE_KEY_RE.test(k) && typeof v === "string") {
            out[k] = FULL_MASK;
        } else if (v !== null && typeof v === "object") {
            out[k] = maskSensitiveFields(v);
        } else {
            out[k] = v;
        }
    }
    return out as T;
}
