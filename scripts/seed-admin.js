const { PrismaClient } = require('@prisma/client');
const { hash } = require('bcryptjs');

// 默认管理员账号：密码不再硬编码 123456；
// - 生产部署时通过环境变量 DEFAULT_ADMIN_PASSWORD 覆盖
// - 如果两者都没给，脚本会拒绝创建（避免把弱密码带进生产）
// - 已有用户的密码永远不会被覆盖
const DEFAULT_ADMIN = {
    email: process.env.DEFAULT_ADMIN_EMAIL || 'admin@localhost',
    password: process.env.DEFAULT_ADMIN_PASSWORD,
    name: process.env.DEFAULT_ADMIN_NAME || 'Admin',
    role: 'admin',
    isActive: true,
    educationStage: 'junior_high',
    enrollmentYear: 2025,
};

async function seedAdmin({ prisma, hash: hashPassword }) {
    const existingUser = await prisma.user.findUnique({
        where: { email: DEFAULT_ADMIN.email },
    });

    if (existingUser) {
        // 已存在的用户：只补 role/isActive 字段，绝不改密码（用户可能已改过）
        const updates = {};
        if (existingUser.role !== DEFAULT_ADMIN.role) updates.role = DEFAULT_ADMIN.role;
        if (existingUser.isActive !== DEFAULT_ADMIN.isActive) updates.isActive = DEFAULT_ADMIN.isActive;
        // 保留用户已设的 educationStage / enrollmentYear，不覆盖
        if (Object.keys(updates).length > 0) {
            await prisma.user.update({
                where: { email: DEFAULT_ADMIN.email },
                data: updates,
            });
        }
        return { action: 'exists', email: DEFAULT_ADMIN.email };
    }

    // 新用户创建：必须有密码
    if (!DEFAULT_ADMIN.password) {
        throw new Error(
            `No admin user exists at ${DEFAULT_ADMIN.email} and DEFAULT_ADMIN_PASSWORD is not set. ` +
            'Aborting — refusing to create an admin with a hardcoded default password.'
        );
    }

    const hashedPassword = await hashPassword(DEFAULT_ADMIN.password, 12);

    await prisma.user.create({
        data: {
            email: DEFAULT_ADMIN.email,
            password: hashedPassword,
            name: DEFAULT_ADMIN.name,
            role: DEFAULT_ADMIN.role,
            isActive: DEFAULT_ADMIN.isActive,
            educationStage: DEFAULT_ADMIN.educationStage,
            enrollmentYear: DEFAULT_ADMIN.enrollmentYear,
            // 种子账号首次登录必须改密码
            mustChangePassword: true,
        },
    });

    return { action: 'created', email: DEFAULT_ADMIN.email };
}

async function main() {
    const prisma = new PrismaClient();

    try {
        const result = await seedAdmin({ prisma, hash });
        if (result.action === 'created') {
            console.log(`[seed-admin] Created admin user: ${result.email}`);
            console.log('[seed-admin] Password was provided via DEFAULT_ADMIN_PASSWORD env var.');
            console.log('[seed-admin] CHANGE IT ON FIRST LOGIN!');
        } else {
            console.log(`[seed-admin] Admin user already exists at ${result.email}. Role/isActive ensured; password untouched.`);
        }
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('[seed-admin] Failed:', error.message);
        // 进程非零退出 — entrypoint 可以选择 abort 或继续，我们这里把错误透传
        process.exit(1);
    });
}

module.exports = { seedAdmin, DEFAULT_ADMIN };
