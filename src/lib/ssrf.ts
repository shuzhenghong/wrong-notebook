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

/**
 * 判断一个 IP 字面量是否属于内网/保留地址。
 * 覆盖 IPv4 各私网段、环回、链路本地、云元数据地址，以及 IPv6 的环回/ULA/链路本地/IPv4-mapped。
 */
export function isDisallowedIp(ip: string): boolean {
    if (!ip) return false;

    let normalized = ip.trim().toLowerCase();

    // IPv4-mapped IPv6：::ffff:127.0.0.1 → 127.0.0.1
    const mappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedMatch) normalized = mappedMatch[1];

    if (normalized.includes(':')) {
        // IPv6
        if (normalized === '::1' || normalized === '::' ) return true;
        if (normalized.startsWith('fe80:') || normalized.startsWith('fec0:')) return true;
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA fc00::/7
        if (normalized.startsWith('ff')) return true; // 组播
        return false;
    }

    // IPv4：支持十进制/八进制/十六进制写法统一转成数值判断
    const parts = normalized.split('.');
    if (parts.length !== 4) return true; // 非法 IP 一律拒绝

    const nums: number[] = [];
    for (const part of parts) {
        if (part === '') return true;
        const n = part.startsWith('0x')
            ? parseInt(part.slice(2), 16)
            : part.startsWith('0') && part.length > 1
                ? parseInt(part, 8)
                : parseInt(part, 10);
        if (Number.isNaN(n) || n < 0 || n > 255) return true;
        nums.push(n);
    }

    const [a, b] = nums;
    if (a === 0) return true;                 // 0.0.0.0/8
    if (a === 10) return true;                // 10.0.0.0/8
    if (a === 127) return true;               // 127.0.0.0/8
    if (a === 169 && b === 254) return true;  // 169.254.0.0/16（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;  // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试网段
    if (a >= 224) return true;                // 组播与保留

    return false;
}

/**
 * 异步版校验：先把主机名解析成 IP，再逐个判断是否落在内网。
 * 用于拦截 "attacker.com → 127.0.0.1" 这类 DNS 重绑定绕过（字符串黑名单拦不住）。
 */
export async function validateBaseUrlWithDns(raw: string | null | undefined): Promise<ValidationResult> {
    const basic = validateBaseUrl(raw);
    if (!basic.ok) return basic;
    if (!raw) return { ok: true };

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, reason: "Invalid URL" };
    }

    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    // 本身就是 IP 字面量
    if (/^[\d.]+$/.test(host) || host.includes(':')) {
        return isDisallowedIp(host)
            ? { ok: false, reason: `Disallowed host: ${host}` }
            : { ok: true };
    }

    try {
        const dns = await import('node:dns');
        const records = await dns.promises.lookup(host, { all: true });
        if (!records || records.length === 0) {
            return { ok: false, reason: `Cannot resolve host: ${host}` };
        }
        for (const record of records) {
            if (isDisallowedIp(record.address)) {
                return {
                    ok: false,
                    reason: `Disallowed host: ${host} resolves to private address ${record.address}`,
                };
            }
        }
    } catch (error) {
        return { ok: false, reason: `Cannot resolve host: ${host}` };
    }

    return { ok: true };
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
