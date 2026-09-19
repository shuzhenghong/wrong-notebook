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

    // 构建期（Docker 镜像构建）刻意不创建管理员，也绝不烘焙任何密码：
    // 管理员账号由容器「首次启动」时的 scripts/seed-admin.js 初始化 ——
    // 它会自动生成强随机密码并打印到启动日志，且登录后强制改密。
    if (!ADMIN_PASSWORD) {
        console.log(
            `\n[seed] 跳过管理员创建：未设置 DEFAULT_ADMIN_PASSWORD。\n` +
            `[seed] 这是预期行为 —— 构建期不烘焙管理员密码；\n` +
            `[seed] 管理员会在容器首次启动时自动创建，密码打印在启动日志中。\n` +
            `[seed] 本地开发想立即创建：export DEFAULT_ADMIN_PASSWORD=<强密码> 后重跑本命令。\n`
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
