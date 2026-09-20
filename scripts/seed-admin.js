const { PrismaClient } = require('@prisma/client');

// bcryptjs v3 的 package.json 声明 "main": "umd/index.js" (CommonJS 入口)，
// 但其 exports 字段只指向根目录 index.js (ESM)。Next.js standalone 模式按 ESM 入口裁剪后，
// umd/ 目录可能缺失。这里做防御性加载：先按标准 require，如果失败再明确报出诊断信息。
let hash;
try {
    const bcrypt = require('bcryptjs');
    hash = bcrypt.hash;
} catch (e) {
    console.error('[seed-admin][FATAL] 无法加载 bcryptjs 模块');
    console.error('[seed-admin]   错误信息:', e.message);
    console.error('[seed-admin]   常见原因:');
    console.error('[seed-admin]     1) Next.js standalone 模式裁剪了 bcryptjs/umd/ 目录');
    console.error('[seed-admin]        → Dockerfile runner 阶段需要显式复制完整 bcryptjs 包');
    console.error('[seed-admin]     2) node_modules 挂载损坏或权限问题');
    console.error('[seed-admin]   诊断命令: ls -la node_modules/bcryptjs/');
    process.exit(2);
}

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ===========================================================================
// 首次部署 · 管理员账号初始化
//
// 行为约定：
//   1. DEFAULT_ADMIN_PASSWORD 已设置 → 用它创建管理员（日志不回显明文）
//   2. DEFAULT_ADMIN_PASSWORD 未设置 → 自动生成强随机密码，
//      并在「部署日志」中醒目打印（首次登录会被强制要求修改密码），
//      同时把凭据落盘到数据卷，避免日志被冲掉后无法登录
//   3. 管理员已存在 → 只校正 role/isActive，绝不改密码
//   4. 显式带 --reset-password 参数 → 重置密码并再次打印（救援通道）
//
// 救援命令（容器内执行）：
//   node /app/dist-scripts/scripts/seed-admin.js --reset-password
// ===========================================================================

const FIELD_DEFAULTS = {
    role: 'admin',
    isActive: true,
    educationStage: 'junior_high',
    enrollmentYear: 2025,
};

// 密码字符集刻意排除易混淆字符（0/O/1/l/I）与 shell 高危字符（! $ & ^ " ' ` \）
// —— 前者避免用户看错抄错，后者避免复制到终端时被 shell 吞掉。
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '-_.@#%+=*';
const ALL_CHARS = UPPER + LOWER + DIGITS + SYMBOLS;
const GENERATED_PASSWORD_LENGTH = 16;

const BANNER_WIDTH = 66;

/** 区间内均匀随机整数（拒绝采样，避免取模偏差） */
function randomIndex(max) {
    if (max <= 0) return 0;
    const limit = 256 - (256 % max);
    for (;;) {
        const byte = crypto.randomBytes(1)[0];
        if (byte < limit) return byte % max;
    }
}

function randomChar(charset) {
    return charset[randomIndex(charset.length)];
}

/**
 * 生成强随机密码：保证同时含大写、小写、数字、符号，且长度 >= 12。
 */
function generatePassword(length = GENERATED_PASSWORD_LENGTH) {
    const size = Math.max(12, Number(length) || GENERATED_PASSWORD_LENGTH);
    const chars = [
        randomChar(UPPER),
        randomChar(LOWER),
        randomChar(DIGITS),
        randomChar(SYMBOLS),
    ];
    while (chars.length < size) chars.push(randomChar(ALL_CHARS));
    // Fisher-Yates 洗牌：保证强制字符不会固定在开头几位
    for (let i = chars.length - 1; i > 0; i -= 1) {
        const j = randomIndex(i + 1);
        const tmp = chars[i];
        chars[i] = chars[j];
        chars[j] = tmp;
    }
    return chars.join('');
}

/** 组装运行时配置（每次调用都重新读 env，便于测试与多次调用） */
function resolveAdminConfig(env = process.env) {
    return {
        email: (env.DEFAULT_ADMIN_EMAIL || 'admin@localhost').trim(),
        name: (env.DEFAULT_ADMIN_NAME || 'Admin').trim(),
        password: env.DEFAULT_ADMIN_PASSWORD || '',
    };
}

/** 凭据文件的默认落盘位置：优先 env，其次数据卷 */
function resolveCredentialsFile(env = process.env) {
    if (env.ADMIN_CREDENTIALS_FILE) return env.ADMIN_CREDENTIALS_FILE;
    if (fs.existsSync('/app/data')) return '/app/data/initial-admin-credentials.txt';
    return '';
}

function writeCredentialsFile(filePath, { email, password, loginUrl, action }) {
    if (!filePath) return null;
    try {
        const dir = path.dirname(filePath);
        if (dir && dir !== '.' && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const lines = [
            '# wrong-notebook 初始管理员凭据',
            `# 生成时间: ${new Date().toISOString()}`,
            `# 触发方式: ${action === 'password-reset' ? '管理员密码重置' : '首次部署自动初始化'}`,
            '# 首次登录后系统会强制要求修改密码；改完密码请删除本文件。',
            `LOGIN_URL=${loginUrl}`,
            `ADMIN_EMAIL=${email}`,
            `ADMIN_PASSWORD=${password}`,
            '',
        ];
        fs.writeFileSync(filePath, lines.join('\n'), { mode: 0o600 });
        try {
            fs.chmodSync(filePath, 0o600);
        } catch (_) {
            // Windows / 部分卷不支持 chmod，忽略即可
        }
        return filePath;
    } catch (_) {
        // 写凭据文件失败不能阻断启动 —— 日志里已经打印过密码
        return null;
    }
}

function buildBanner({ email, password, passwordSource, action, loginUrl, credentialsFile }) {
    const line = '='.repeat(BANNER_WIDTH);
    const sub = '-'.repeat(BANNER_WIDTH);
    const title = action === 'password-reset'
        ? '管理员密码已重置（请立即登录并修改）'
        : '首次部署初始化完成 · 管理员账号已创建';
    const rows = [
        '',
        line,
        `  ${title}`,
        sub,
        `  登录地址 : ${loginUrl}`,
        `  用户名   : ${email}`,
    ];

    if (password) {
        rows.push(`  密码     : ${password}   <<< 请立即记录`);
    } else if (passwordSource === 'env') {
        rows.push('  密码     : 使用 DEFAULT_ADMIN_PASSWORD 环境变量中的值（不回显）');
    }

    rows.push(sub);
    if (password) {
        rows.push('  * 首次登录后系统会强制要求您修改密码。');
        rows.push('  * 该密码只在创建/重置时打印一次，重启容器不会再次显示。');
        if (credentialsFile) {
            rows.push(`  * 凭据已备份到数据卷：${credentialsFile}`);
        }
    } else {
        rows.push('  * 密码由您通过 DEFAULT_ADMIN_PASSWORD 指定，故此处不回显。');
        rows.push('  * 留空该变量可让系统自动生成并在日志中打印密码。');
    }
    rows.push('  * 忘记密码时，在容器内执行（会重置并打印新密码）：');
    rows.push('      node /app/dist-scripts/scripts/seed-admin.js --reset-password');
    rows.push(line);
    rows.push('');
    return rows.join('\n');
}

function parseArgs(argv = []) {
    const parsed = { resetPassword: false, password: '', email: '' };
    for (const raw of argv) {
        const arg = String(raw);
        if (arg === '--reset-password' || arg === '-r') {
            parsed.resetPassword = true;
        } else if (arg.startsWith('--password=')) {
            parsed.password = arg.slice('--password='.length);
        } else if (arg.startsWith('--email=')) {
            parsed.email = arg.slice('--email='.length);
        }
    }
    return parsed;
}

/**
 * 确保存在一个可用的管理员账号。
 *
 * @param {object}   options
 * @param {object}   options.prisma             PrismaClient（测试可注入 mock）
 * @param {Function} options.hash               bcrypt hash 实现
 * @param {object}   [options.env]              环境变量来源，默认 process.env
 * @param {boolean}  [options.resetPassword]    已存在管理员时是否强制重置密码
 * @param {string}   [options.password]         显式指定密码（覆盖 env）
 * @param {string}   [options.email]            显式指定邮箱（覆盖 env）
 * @returns {Promise<{action: 'exists'|'created'|'password-reset', email: string, password?: string, passwordSource?: 'env'|'generated'}>}
 */
async function seedAdmin(options = {}) {
    const {
        prisma,
        hash: hashPassword,
        env = process.env,
        resetPassword = false,
    } = options;

    if (!prisma) throw new Error('seedAdmin requires a prisma client');
    if (typeof hashPassword !== 'function') throw new Error('seedAdmin requires a hash function');

    const config = resolveAdminConfig(env);
    const email = (options.email || config.email).trim();
    const explicitPassword = options.password || config.password || '';

    const existingUser = await prisma.user.findUnique({ where: { email } });

    // ---- 已存在且未要求重置：只校正 role/isActive，绝不动密码 ----
    if (existingUser && !resetPassword) {
        const updates = {};
        if (existingUser.role !== FIELD_DEFAULTS.role) updates.role = FIELD_DEFAULTS.role;
        if (existingUser.isActive !== FIELD_DEFAULTS.isActive) updates.isActive = FIELD_DEFAULTS.isActive;
        if (Object.keys(updates).length > 0) {
            await prisma.user.update({ where: { email }, data: updates });
        }
        return { action: 'exists', email };
    }

    // ---- 生成/采用密码 ----
    const passwordSource = explicitPassword ? 'env' : 'generated';
    const password = explicitPassword || generatePassword();
    if (explicitPassword && explicitPassword.length < 8) {
        // 不阻断启动（老部署可能已在使用短密码），但必须提醒风险
        console.warn('[seed-admin] 警告: 指定的管理员密码不足 8 位，建议改用更长的密码或留空让系统自动生成。');
    }
    const hashedPassword = await hashPassword(password, 12);

    if (existingUser) {
        // 显式重置路径：覆盖密码并要求下次登录改密
        await prisma.user.update({
            where: { email },
            data: {
                password: hashedPassword,
                role: FIELD_DEFAULTS.role,
                isActive: FIELD_DEFAULTS.isActive,
                mustChangePassword: true,
            },
        });
        return { action: 'password-reset', email, password, passwordSource };
    }

    await prisma.user.create({
        data: {
            email,
            password: hashedPassword,
            name: options.name || config.name,
            role: FIELD_DEFAULTS.role,
            isActive: FIELD_DEFAULTS.isActive,
            educationStage: FIELD_DEFAULTS.educationStage,
            enrollmentYear: FIELD_DEFAULTS.enrollmentYear,
            // 种子账号首次登录必须改密码
            mustChangePassword: true,
        },
    });

    return { action: 'created', email, password, passwordSource };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const prisma = new PrismaClient();
    const env = process.env;

    try {
        const result = await seedAdmin({
            prisma,
            hash,
            env,
            resetPassword: args.resetPassword,
            password: args.password,
            email: args.email,
        });

        if (result.action === 'exists') {
            console.log(`[seed-admin] 管理员账号已存在：${result.email}（保留原密码，仅校正 role/isActive）`);
            console.log('[seed-admin] 忘记密码？执行 node /app/dist-scripts/scripts/seed-admin.js --reset-password');
            return;
        }

        // env 来源的密码不回显，也不落盘 —— 用户自己设置的密码不应被额外暴露
        const printablePassword = result.passwordSource === 'generated' ? result.password : null;
        const loginUrl = env.NEXTAUTH_URL || 'http://<服务器IP>:3000';
        const credentialsFile = printablePassword
            ? writeCredentialsFile(resolveCredentialsFile(env), {
                email: result.email,
                password: result.password,
                loginUrl,
                action: result.action,
            })
            : null;

        console.log(buildBanner({
            email: result.email,
            password: printablePassword,
            passwordSource: result.passwordSource,
            action: result.action,
            loginUrl,
            credentialsFile,
        }));
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('[seed-admin] Failed:', error.message);
        // 进程非零退出 —— entrypoint 会据此判定初始化失败
        process.exit(1);
    });
}

module.exports = {
    seedAdmin,
    generatePassword,
    buildBanner,
    parseArgs,
    resolveAdminConfig,
    resolveCredentialsFile,
    writeCredentialsFile,
};
