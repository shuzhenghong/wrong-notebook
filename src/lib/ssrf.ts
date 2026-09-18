/**
 * SSRF 防护：baseUrl 协议白名单 + 内网/元数据地址黑名单
 *
 * 防御用户把 baseUrl 指到 http://169.254.169.254/latest/meta-data/ 或 127.0.0.1 / 内网段。
 */

// 禁止用户填的协议（默认只允许 http/https）
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// 必须拒绝的主机模式
const DISALLOWED_HOST_PATTERNS: RegExp[] = [
    // 云元数据端点
    /^169\.254\.169\.254$/,
    /^metadata\.google\.internal$/,
    /^100\.96\.0\.96$/, // Aliyun
    /^100\.100\.100\.200$/, // Tencent
    /^172\.31\.100\.200$/, // Huawei
    /^metadata\.tencentcloud\.net$/,
    // IPv4 私网
    /^127\./,       // loopback
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
    /^0\./,
    // 保留/链路本地组播
    /^224\./,
    /^239\./,
    /^255\./,
    /^169\.254\./, // 链路本地
    // IPv6 常见内网
    /^::1$/,
    /^\[::1\]$/,
    /^fe80:/i,
    /^fc00:/i,
    /^fd00:/i,
];

// 允许的域名后缀白名单（可选；如果不想限制域名后缀，可注释掉下面这一行）
// 这里保持宽松，让用户可用任何公网域名，但绝不允许 IP 直连的私网/环回。

export interface ValidationResult {
    ok: boolean;
    reason?: string;
}

export function validateBaseUrl(raw: string | null | undefined): ValidationResult {
    if (!raw) return { ok: true }; // 空值表示用默认值，合法

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, reason: "Invalid URL" };
    }

    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        return { ok: false, reason: `Disallowed protocol: ${url.protocol}. Only http/https allowed.` };
    }

    const host = url.hostname.toLowerCase();

    // 先判断：如果是纯 IP 或者 localhost，进一步检查内网
    // 正常公网域名（example.com / api.openai.com）不匹配上面那些正则 → 放行
    for (const pattern of DISALLOWED_HOST_PATTERNS) {
        if (pattern.test(host)) {
            return { ok: false, reason: `Disallowed host: ${host}` };
        }
    }

    // localhost 也视为保留
    if (host === "localhost" || host === "localhost.") {
        return { ok: false, reason: "Disallowed host: localhost" };
    }

    // 避免 file://、data:// 这种绕过
    if (url.port && url.port !== "" && parseInt(url.port, 10) === 0) {
        return { ok: false, reason: "Disallowed port: 0" };
    }

    return { ok: true };
}
