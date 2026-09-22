export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        // 安全校验：NEXTAUTH_SECRET 必须存在且非示例值，否则整个认证体系形同虚设
        const secret = process.env.NEXTAUTH_SECRET;
        const INSECURE_VALUES = new Set([
            '',
            'your_secret_key',
            'your-secret-key',
            'changeme',
            'your_secret_key_here',
            'example-secret',
            'test-secret',
        ]);

        if (!secret || INSECURE_VALUES.has(secret.trim().toLowerCase()) || secret.length < 16) {
            // 允许本地开发 / 测试环境自动生成一个随机值，避免本地跑起来就报错
            const isDev = process.env.NODE_ENV !== 'production';
            const isTest = process.env.VITEST === 'true';
            if (isDev || isTest) {
                const crypto = await import('crypto');
                const generated = crypto.randomBytes(32).toString('hex');
                process.env.NEXTAUTH_SECRET = generated;
                // eslint-disable-next-line no-console
                console.warn(
                    '[security] NEXTAUTH_SECRET missing or insecure — generated a random one for this process. ' +
                    'Set a strong NEXTAUTH_SECRET in .env / docker-compose for production.'
                );
            } else {
                // 生产环境：直接拒绝启动
                // eslint-disable-next-line no-console
                console.error(
                    '\n[security] FATAL: NEXTAUTH_SECRET is missing, too short, or is a well-known placeholder. ' +
                    'Aborting startup. Set a long random secret in your environment.\n'
                );
                process.exit(1);
            }
        }

        const { setupGlobalProxy } = await import('./lib/global-proxy');
        setupGlobalProxy();
        // 注：本地 OCR 引擎预热已移除 —— OCR 现在跑在 Python 后端，
        // 那里由 lazy 单例 + 结果缓存承担首次请求的模型加载开销。
    }
}
