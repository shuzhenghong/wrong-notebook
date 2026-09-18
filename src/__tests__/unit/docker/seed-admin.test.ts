import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// seed-admin.js 现在从 env 读 DEFAULT_ADMIN_PASSWORD 而非硬编码 123456。
// 测试前设好，保证新用户创建路径可达。
const PASSWORD_ENV = 'TEST-ADMIN-PASSWORD-12345';

describe('seed-admin docker helper', () => {
    beforeEach(() => {
        process.env.DEFAULT_ADMIN_PASSWORD = PASSWORD_ENV;
        delete process.env.DEFAULT_ADMIN_EMAIL;
        delete process.env.DEFAULT_ADMIN_NAME;
    });
    afterEach(() => {
        delete process.env.DEFAULT_ADMIN_PASSWORD;
        delete process.env.DEFAULT_ADMIN_EMAIL;
        delete process.env.DEFAULT_ADMIN_NAME;
        vi.resetModules();
    });

    it('creates the default admin user when it does not exist', async () => {
        const createdUsers: unknown[] = [];
        const prisma = {
            user: {
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn().mockImplementation(async ({ data }) => {
                    createdUsers.push(data);
                    return { email: data.email };
                }),
                update: vi.fn(),
            },
        };
        const hash = vi.fn().mockResolvedValue('hashed-password');
        const { seedAdmin } = require('../../../../scripts/seed-admin.js');

        const result = await seedAdmin({ prisma, hash });

        expect(result).toEqual({ action: 'created', email: 'admin@localhost' });
        expect(hash).toHaveBeenCalledWith(PASSWORD_ENV, 12);
        expect(prisma.user.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                email: 'admin@localhost',
                password: 'hashed-password',
                role: 'admin',
                isActive: true,
            }),
        });
        expect(createdUsers).toHaveLength(1);
    });

    it('preserves user data when admin already exists and is already correct', async () => {
        const prisma = {
            user: {
                findUnique: vi.fn().mockResolvedValue({
                    email: 'admin@localhost', role: 'admin', isActive: true,
                    educationStage: 'senior_high', enrollmentYear: 2024,
                }),
                create: vi.fn(),
                update: vi.fn(),
            },
        };
        const hash = vi.fn();
        const { seedAdmin } = require('../../../../scripts/seed-admin.js');

        const result = await seedAdmin({ prisma, hash });

        expect(result).toEqual({ action: 'exists', email: 'admin@localhost' });
        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('restores admin role when user role was reset to user', async () => {
        const prisma = {
            user: {
                findUnique: vi.fn().mockResolvedValue({
                    email: 'admin@localhost',
                    role: 'user', // Role was reset by migration
                    isActive: true,
                    educationStage: 'senior_high',
                    enrollmentYear: 2024,
                }),
                create: vi.fn(),
                update: vi.fn().mockResolvedValue({ email: 'admin@localhost' }),
            },
        };
        const hash = vi.fn();
        const { seedAdmin } = require('../../../../scripts/seed-admin.js');

        const result = await seedAdmin({ prisma, hash });

        expect(result).toEqual({ action: 'exists', email: 'admin@localhost' });
        // 内部确实触发了 update（字段变化时），但我们不关心返回值
        // 这里 seed-admin 不暴露 action='updated' 了，因为已存在用户一律走 'exists' 路径
        expect(prisma.user.update).toHaveBeenCalled();
        const updateArg = prisma.user.update.mock.calls[0][0];
        expect(updateArg.where).toEqual({ email: 'admin@localhost' });
        expect(updateArg.data.role).toBe('admin');
    });

    it('reactivates admin when isActive was set to false', async () => {
        const prisma = {
            user: {
                findUnique: vi.fn().mockResolvedValue({
                    email: 'admin@localhost',
                    role: 'admin',
                    isActive: false,
                    educationStage: 'junior_high',
                    enrollmentYear: 2025,
                }),
                create: vi.fn(),
                update: vi.fn().mockResolvedValue({ email: 'admin@localhost' }),
            },
        };
        const hash = vi.fn();
        const { seedAdmin } = require('../../../../scripts/seed-admin.js');

        await seedAdmin({ prisma, hash });

        expect(prisma.user.update).toHaveBeenCalled();
        const updateArg = prisma.user.update.mock.calls[0][0];
        expect(updateArg.data.isActive).toBe(true);
    });

    it('never touches existing password', async () => {
        const prisma = {
            user: {
                findUnique: vi.fn().mockResolvedValue({
                    email: 'admin@localhost',
                    role: 'user', isActive: false,
                    educationStage: 'junior_high', enrollmentYear: 2025,
                }),
                create: vi.fn(),
                update: vi.fn().mockResolvedValue({ email: 'admin@localhost' }),
            },
        };
        const hash = vi.fn();
        const { seedAdmin } = require('../../../../scripts/seed-admin.js');

        await seedAdmin({ prisma, hash });

        expect(hash).not.toHaveBeenCalled();
        const updateArg = prisma.user.update.mock.calls[0][0];
        // update.data 里绝不能有 password 字段
        expect('password' in updateArg.data).toBe(false);
    });
});
