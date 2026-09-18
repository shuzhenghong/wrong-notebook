import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { hash, compare } from "bcryptjs";
import { badRequest, notFound, validationError, internalError } from "@/lib/api-errors";
import { getCurrentUser } from "@/lib/server-auth";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:user');

const userUpdateSchema = z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    password: z.string().optional(),
    // 修改密码时必须提供的当前密码（首次强制改密流程除外）
    currentPassword: z.string().optional(),
    educationStage: z.string().optional(),
    enrollmentYear: z.number().optional().nullable(),
});

export async function GET() {
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    try {
        const user = await prisma.user.findUnique({
            where: { id: auth.user.id },
            select: {
                name: true,
                email: true,
                educationStage: true,
                enrollmentYear: true,
                mustChangePassword: true,
                // Do not return password
            }
        });

        if (!user) {
            return notFound("User not found");
        }

        logger.debug({ user }, 'Returning user profile');

        return NextResponse.json(user);
    } catch (error) {
        logger.error({ error }, 'Failed to fetch user profile');
        return internalError("Failed to fetch user profile");
    }
}

export async function PATCH(req: Request) {
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    try {
        const body = await req.json();
        const { name, email, password, currentPassword, educationStage, enrollmentYear } = userUpdateSchema.parse(body);

        const updateData: any = {};

        // 只有非空字符串才会触发更新
        if (name && name.trim()) updateData.name = name.trim();
        if (educationStage && educationStage.trim()) updateData.educationStage = educationStage.trim();
        if (typeof enrollmentYear === 'number' && !isNaN(enrollmentYear)) {
            updateData.enrollmentYear = enrollmentYear;
        }

        // 验证邮箱格式（如果提供了邮箱）
        // 支持标准邮箱和本地邮箱（如 admin@localhost）
        if (email && email.trim()) {
            const emailRegex = /^[^\s@]+@[^\s@]+$/;
            if (!emailRegex.test(email.trim())) {
                return badRequest("Invalid email format");
            }
            updateData.email = email.trim();
        }

        // 验证密码（如果提供了密码）
        if (password && password.length > 0) {
            if (password.length < 8) {
                return badRequest("Password must be at least 8 characters");
            }

            // 安全校验：改密必须验证当前密码，防止会话令牌被盗后直接改密锁死账户。
            // 例外：首次登录强制改密（mustChangePassword）流程 —— 用户刚用临时密码完成登录。
            const userRecord = await prisma.user.findUnique({
                where: { id: auth.user.id },
                select: { password: true, mustChangePassword: true },
            });
            if (!userRecord) {
                return notFound("User not found");
            }

            if (!userRecord.mustChangePassword) {
                if (!currentPassword) {
                    return badRequest("Current password is required to change password");
                }
                const currentValid = await compare(currentPassword, userRecord.password);
                if (!currentValid) {
                    logger.warn({ userId: auth.user.id }, 'Password change rejected: wrong current password');
                    return badRequest("Current password is incorrect");
                }
            }

            updateData.password = await hash(password, 12);
            // 主动改过密码后，解除"首次登录强制改密"标记
            updateData.mustChangePassword = false;
        }

        const updatedUser = await prisma.user.update({
            where: { id: auth.user.id },
            data: updateData,
            select: {
                name: true,
                email: true,
                educationStage: true,
                enrollmentYear: true,
                mustChangePassword: true,
            }
        });

        return NextResponse.json(updatedUser);
    } catch (error) {
        logger.error({ error }, 'Failed to update user profile');
        if (error instanceof z.ZodError) {
            return validationError("Invalid input", error.issues);
        }
        return internalError("Failed to update user profile");
    }
}
