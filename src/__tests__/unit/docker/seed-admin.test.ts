import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * scripts/seed-admin.js 单元测试
 *
 * 覆盖「首次部署初始化管理员账号」的全部关键行为：
 *   1. 未指定密码 → 自动生成强随机密码（并可在部署日志中打印）
 *   2. 显式指定密码（env / --password）→ 采用但标记来源为 env
 *   3. 账号已存在 → 幂等，只校正 role/isActive，绝不覆盖密码
 *   4. --reset-password → 覆盖密码并要求下次登录改密
 *   5. 凭据落盘、横幅渲染、CLI 参数解析
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const seedAdminModule = require(path.resolve(process.cwd(), 'scripts/seed-admin.js'));

const {
    seedAdmin,
    generatePassword,
    buildBanner,
    parseArgs,
    resolveAdminConfig,
    resolveCredentialsFile,
    writeCredentialsFile,
} = seedAdminModule;

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

// 刻意使用「一眼可辨的合成值」，避免任何真实凭据形状的字面量进入仓库
const FIXTURE_SECRET = 'fixture-value-not-a-real-secret';
const FIXTURE_EMAIL = 'admin@localhost';

// 管理员账号上被允许出现的字段默认值（与实现保持一致）
const EXPECTED_DEFAULTS = {
    role: 'admin',
    isActive: true,
    educationStage: 'junior_high',
    enrollmentYear: 2025,
};

/**
 * 构造测试用的环境变量对象。
 * Next.js 的 ProcessEnv 要求 NODE_ENV 必填，测试里不需要真实进程环境，故集中在此做一次安全转换。
 */
function envOf(vars: Record<string, string> = {}): NodeJS.ProcessEnv {
    return vars as unknown as NodeJS.ProcessEnv;
}

function makePrisma(existingUser: unknown = null) {
    const created: Array<Record<string, any>> = [];
    const updated: Array<Record<string, any>> = [];
    return {
        user: {
            findUnique: vi.fn().mockImplementation(async () => existingUser),
            create: vi.fn().mockImplementation(async ({ data }: any) => {
                created.push(data);
                return { ...data };
            }),
            update: vi.fn().mockImplementation(async ({ data }: any) => {
                updated.push(data);
                return {};
            }),
        },
        created,
        updated,
    };
}

/** hash 用可预测前缀替代，便于断言"确实对明文做了哈希" */
function makeHash() {
    return vi.fn().mockImplementation(async (value: string) => `hashed::${value}`);
}

// ---------------------------------------------------------------------------
// 密码生成
// ---------------------------------------------------------------------------

describe('generatePassword', () => {
    it('默认生成 16 位密码，且同时包含大写、小写、数字与符号', () => {
        const password = generatePassword();

        expect(password).toHaveLength(16);
        expect(password).toMatch(/[A-Z]/);
        expect(password).toMatch(/[a-z]/);
        expect(password).toMatch(/[0-9]/);
        expect(password).toMatch(/[-_.@#%+=*]/);
    });

    it('排除易混淆字符（0 O 1 l I）与 shell 高危字符', () => {
        // 生成足够多次，覆盖到绝大多数字符集分支
        const joined = Array.from({ length: 200 }, () => generatePassword()).join('');

        expect(joined).not.toMatch(/[0O1lI]/);
        expect(joined).not.toMatch(/[!$&^"'`\\|;<>(){}[\]~]/);
    });

    it('对过小的入参做下限保护，长度不低于 12', () => {
        expect(generatePassword(4).length).toBeGreaterThanOrEqual(12);
        expect(generatePassword(0).length).toBeGreaterThanOrEqual(12);
    });

    it('连续调用结果不重复（具备随机性）', () => {
        const samples = new Set(Array.from({ length: 50 }, () => generatePassword()));
        expect(samples.size).toBe(50);
    });
});

// ---------------------------------------------------------------------------
// CLI 参数解析
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
    it('识别重置密码开关的长短写法', () => {
        expect(parseArgs(['--reset-password']).resetPassword).toBe(true);
        expect(parseArgs(['-r']).resetPassword).toBe(true);
        expect(parseArgs([]).resetPassword).toBe(false);
    });

    it('解析 --password= 与 --email= 的取值', () => {
        const parsed = parseArgs(['--reset-password', `--password=${FIXTURE_SECRET}`, '--email=a@b.c']);

        expect(parsed.password).toBe(FIXTURE_SECRET);
        expect(parsed.email).toBe('a@b.c');
    });

    it('忽略无法识别的参数且不抛错', () => {
        expect(() => parseArgs(['--unknown', 'positional'])).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// 环境变量解析
// ---------------------------------------------------------------------------

describe('resolveAdminConfig', () => {
    it('缺省时回退到 admin@localhost / Admin / 空密码', () => {
        const config = resolveAdminConfig(envOf());

        expect(config.email).toBe('admin@localhost');
        expect(config.name).toBe('Admin');
        expect(config.password).toBe('');
    });

    it('环境变量可覆盖默认值并去除首尾空白', () => {
        const config = resolveAdminConfig(envOf({
            DEFAULT_ADMIN_EMAIL: '  owner@example.com  ',
            DEFAULT_ADMIN_NAME: '  Owner  ',
            DEFAULT_ADMIN_PASSWORD: FIXTURE_SECRET,
        }));

        expect(config.email).toBe('owner@example.com');
        expect(config.name).toBe('Owner');
        expect(config.password).toBe(FIXTURE_SECRET);
    });
});

describe('resolveCredentialsFile', () => {
    it('显式指定 ADMIN_CREDENTIALS_FILE 时优先采用', () => {
        expect(resolveCredentialsFile(envOf({ ADMIN_CREDENTIALS_FILE: '/tmp/creds.txt' })))
            .toBe('/tmp/creds.txt');
    });

    it('未指定且数据卷不存在时返回空字符串（表示不落盘）', () => {
        expect(resolveCredentialsFile(envOf())).toBe('');
    });
});

// ---------------------------------------------------------------------------
// 凭据落盘
// ---------------------------------------------------------------------------

describe('writeCredentialsFile', () => {
    let dir = '';

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-admin-test-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('未提供路径时直接返回 null，不抛错', () => {
        expect(writeCredentialsFile('', { email: FIXTURE_EMAIL, password: FIXTURE_SECRET, loginUrl: '', action: 'created' }))
            .toBeNull();
    });

    it('自动创建父目录并写入账号密码等关键信息', () => {
        const target = path.join(dir, 'nested', 'credentials.txt');

        const written = writeCredentialsFile(target, {
            email: FIXTURE_EMAIL,
            password: FIXTURE_SECRET,
            loginUrl: 'http://127.0.0.1:3000',
            action: 'created',
        });

        expect(written).toBe(target);
        const content = fs.readFileSync(target, 'utf8');
        expect(content).toContain(`ADMIN_EMAIL=${FIXTURE_EMAIL}`);
        expect(content).toContain(`ADMIN_PASSWORD=${FIXTURE_SECRET}`);
        expect(content).toContain('LOGIN_URL=http://127.0.0.1:3000');
        expect(content).toContain('首次登录后系统会强制要求修改密码');
    });

    it('重置场景会标注触发方式为密码重置', () => {
        const target = path.join(dir, 'reset.txt');

        writeCredentialsFile(target, {
            email: FIXTURE_EMAIL,
            password: FIXTURE_SECRET,
            loginUrl: '',
            action: 'password-reset',
        });

        expect(fs.readFileSync(target, 'utf8')).toContain('管理员密码重置');
    });
});

// ---------------------------------------------------------------------------
// 核心：seedAdmin
// ---------------------------------------------------------------------------

describe('seedAdmin · 首次部署（库中无管理员）', () => {
    it('未提供密码时自动生成强随机密码，并标记来源为 generated', async () => {
        const prisma = makePrisma(null);
        const hashFn = makeHash();

        const result = await seedAdmin({ prisma, hash: hashFn, env: envOf() });

        expect(result.action).toBe('created');
        expect(result.email).toBe(FIXTURE_EMAIL);
        expect(result.passwordSource).toBe('generated');
        expect(typeof result.password).toBe('string');
        expect(result.password!.length).toBeGreaterThanOrEqual(12);

        // 明文密码不得直接入库，必须经过 hash
        expect(hashFn).toHaveBeenCalledWith(result.password, 12);
        expect(prisma.created).toHaveLength(1);
        expect(prisma.created[0].password).toBe(`hashed::${result.password}`);
    });

    it('新账号带上全部默认字段，且首次登录强制改密', async () => {
        const prisma = makePrisma(null);

        await seedAdmin({ prisma, hash: makeHash(), env: envOf() });

        const data = prisma.created[0];
        expect(data.email).toBe(FIXTURE_EMAIL);
        expect(data.role).toBe(EXPECTED_DEFAULTS.role);
        expect(data.isActive).toBe(EXPECTED_DEFAULTS.isActive);
        expect(data.educationStage).toBe(EXPECTED_DEFAULTS.educationStage);
        expect(data.enrollmentYear).toBe(EXPECTED_DEFAULTS.enrollmentYear);
        expect(data.mustChangePassword).toBe(true);
    });

    it('环境变量提供密码时采用该密码，并标记来源为 env', async () => {
        const prisma = makePrisma(null);
        const hashFn = makeHash();

        const result = await seedAdmin({
            prisma,
            hash: hashFn,
            env: envOf({ DEFAULT_ADMIN_PASSWORD: FIXTURE_SECRET }),
        });

        expect(result.passwordSource).toBe('env');
        expect(result.password).toBe(FIXTURE_SECRET);
        expect(prisma.created[0].password).toBe(`hashed::${FIXTURE_SECRET}`);
    });

    it('显式传入的密码优先于环境变量', async () => {
        const prisma = makePrisma(null);

        const result = await seedAdmin({
            prisma,
            hash: makeHash(),
            env: envOf({ DEFAULT_ADMIN_PASSWORD: 'from-environment-value' }),
            password: FIXTURE_SECRET,
        });

        expect(result.password).toBe(FIXTURE_SECRET);
    });

    it('自定义邮箱会被采用', async () => {
        const prisma = makePrisma(null);

        const result = await seedAdmin({
            prisma,
            hash: makeHash(),
            env: envOf({ DEFAULT_ADMIN_EMAIL: 'owner@example.com' }),
        });

        expect(result.email).toBe('owner@example.com');
        expect(prisma.created[0].email).toBe('owner@example.com');
    });

    it('缺少 prisma 或 hash 依赖时立刻抛出明确错误', async () => {
        await expect(seedAdmin({ hash: makeHash() } as any)).rejects.toThrow(/prisma/i);
        await expect(seedAdmin({ prisma: makePrisma(null) } as any)).rejects.toThrow(/hash/i);
    });
});

describe('seedAdmin · 幂等（库中已有管理员）', () => {
    it('role/isActive 已正确时不产生任何写操作', async () => {
        const prisma = makePrisma({ email: FIXTURE_EMAIL, role: 'admin', isActive: true });

        const result = await seedAdmin({ prisma, hash: makeHash(), env: envOf() });

        expect(result.action).toBe('exists');
        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('role 不正确时只校正 role，绝不触碰密码字段', async () => {
        const prisma = makePrisma({ email: FIXTURE_EMAIL, role: 'user', isActive: true });

        await seedAdmin({ prisma, hash: makeHash(), env: envOf() });

        expect(prisma.user.update).toHaveBeenCalledTimes(1);
        expect(prisma.updated[0]).toEqual({ role: 'admin' });
        expect(prisma.updated[0]).not.toHaveProperty('password');
    });

    it('账号被停用时重新激活', async () => {
        const prisma = makePrisma({ email: FIXTURE_EMAIL, role: 'admin', isActive: false });

        await seedAdmin({ prisma, hash: makeHash(), env: envOf() });

        expect(prisma.updated[0]).toEqual({ isActive: true });
    });

    it('即便提供了新密码也不会覆盖既有密码（除非显式 reset）', async () => {
        const prisma = makePrisma({ email: FIXTURE_EMAIL, role: 'admin', isActive: true });
        const hashFn = makeHash();

        const result = await seedAdmin({
            prisma,
            hash: hashFn,
            env: envOf({ DEFAULT_ADMIN_PASSWORD: FIXTURE_SECRET }),
        });

        expect(result.action).toBe('exists');
        expect(result.password).toBeUndefined();
        expect(hashFn).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
    });
});

describe('seedAdmin · 救援通道（--reset-password）', () => {
    it('显式重置时覆盖密码并要求下次登录改密', async () => {
        const prisma = makePrisma({ email: FIXTURE_EMAIL, role: 'admin', isActive: true });
        const hashFn = makeHash();

        const result = await seedAdmin({
            prisma,
            hash: hashFn,
            env: envOf(),
            resetPassword: true,
        });

        expect(result.action).toBe('password-reset');
        expect(result.passwordSource).toBe('generated');
        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(prisma.updated[0].password).toBe(`hashed::${result.password}`);
        expect(prisma.updated[0].mustChangePassword).toBe(true);
        expect(prisma.updated[0].role).toBe('admin');
        expect(prisma.updated[0].isActive).toBe(true);
    });

    it('重置时可用显式密码覆盖', async () => {
        const prisma = makePrisma({ email: FIXTURE_EMAIL, role: 'admin', isActive: true });

        const result = await seedAdmin({
            prisma,
            hash: makeHash(),
            env: envOf(),
            resetPassword: true,
            password: FIXTURE_SECRET,
        });

        expect(result.password).toBe(FIXTURE_SECRET);
        expect(result.passwordSource).toBe('env');
        expect(prisma.updated[0].password).toBe(`hashed::${FIXTURE_SECRET}`);
    });
});

// ---------------------------------------------------------------------------
// 部署日志渲染
// ---------------------------------------------------------------------------

describe('buildBanner', () => {
    it('自动生成密码时，横幅中包含登录地址、用户名与明文密码', () => {
        const banner = buildBanner({
            email: FIXTURE_EMAIL,
            password: FIXTURE_SECRET,
            passwordSource: 'generated',
            action: 'created',
            loginUrl: 'http://192.168.1.10:3000',
            credentialsFile: '/app/data/initial-admin-credentials.txt',
        });

        expect(banner).toContain('首次部署初始化完成');
        expect(banner).toContain(FIXTURE_EMAIL);
        expect(banner).toContain(FIXTURE_SECRET);
        expect(banner).toContain('http://192.168.1.10:3000');
        expect(banner).toContain('/app/data/initial-admin-credentials.txt');
        expect(banner).toContain('强制要求您修改密码');
        expect(banner).toContain('--reset-password');
    });

    it('密码来自环境变量时不回显明文', () => {
        const banner = buildBanner({
            email: FIXTURE_EMAIL,
            password: null,
            passwordSource: 'env',
            action: 'created',
            loginUrl: 'http://localhost:3000',
            credentialsFile: null,
        });

        expect(banner).not.toContain(FIXTURE_SECRET);
        expect(banner).toContain('不回显');
        expect(banner).toContain(FIXTURE_EMAIL);
    });

    it('重置场景使用对应的标题', () => {
        const banner = buildBanner({
            email: FIXTURE_EMAIL,
            password: FIXTURE_SECRET,
            passwordSource: 'generated',
            action: 'password-reset',
            loginUrl: 'http://localhost:3000',
            credentialsFile: null,
        });

        expect(banner).toContain('管理员密码已重置');
    });

    it('未落盘时不输出凭据文件路径', () => {
        const banner = buildBanner({
            email: FIXTURE_EMAIL,
            password: FIXTURE_SECRET,
            passwordSource: 'generated',
            action: 'created',
            loginUrl: 'http://localhost:3000',
            credentialsFile: null,
        });

        expect(banner).not.toContain('initial-admin-credentials.txt');
    });
});
