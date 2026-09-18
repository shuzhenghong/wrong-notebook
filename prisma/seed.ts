import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.DEFAULT_ADMIN_EMAIL || 'admin@localhost';
const ADMIN_NAME = process.env.DEFAULT_ADMIN_NAME || 'Admin';
// 密码只能来自环境变量，绝不硬编码默认值
const ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD;

async function main() {
    console.log(`Checking admin user: ${ADMIN_EMAIL}...`);

    const existingUser = await prisma.user.findUnique({
        where: { email: ADMIN_EMAIL },
    });

    if (existingUser) {
        console.log(`Admin user already exists. Ensuring role/isActive are correct...`);
        await prisma.user.update({
            where: { email: ADMIN_EMAIL },
            data: {
                role: 'admin',
                isActive: true,
            }
        });
        return;
    }

    // 没有显式提供密码就绝不创建管理员 —— 避免把弱口令带进任何环境
    if (!ADMIN_PASSWORD) {
        console.log(
            `\n[seed] No admin user exists and DEFAULT_ADMIN_PASSWORD is not set.\n` +
            `[seed] Refusing to create an admin with a hardcoded password.\n` +
            `[seed] Set DEFAULT_ADMIN_PASSWORD and re-run, or register a user and run:\n` +
            `[seed]   node scripts/seed-admin.js\n`
        );
        return;
    }

    console.log(`Admin user not found. Creating...`);
    const hashedPassword = await hash(ADMIN_PASSWORD, 12);

    const user = await prisma.user.create({
        data: {
            email: ADMIN_EMAIL,
            password: hashedPassword,
            name: ADMIN_NAME,
            role: 'admin',
            isActive: true,
            educationStage: 'junior_high',
            enrollmentYear: 2025,
            // 种子创建的账号首次登录必须改密码
            mustChangePassword: true,
        },
    });

    console.log(`\nSuccess! Admin user created.`);
    console.log(`Email: ${user.email}`);
    console.log(`Password: (取自 DEFAULT_ADMIN_PASSWORD，不再回显到日志)`);
    console.log(`首次登录将强制修改密码。`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
