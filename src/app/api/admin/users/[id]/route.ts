import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { getAdminUser } from "@/lib/server-auth"
import { badRequest, internalError } from "@/lib/api-errors"
import { deleteUserImages } from "@/lib/image-storage"
import { createLogger } from "@/lib/logger"

const logger = createLogger('api:admin:users:id');

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const auth = await getAdminUser()
    if (!auth.ok) return auth.response

    try {
        const body = await req.json()
        const { isActive } = body

        if (typeof isActive !== 'boolean') {
            return badRequest("isActive must be a boolean")
        }

        // Prevent disabling self
        if (id === auth.user.id) {
            return badRequest("Cannot disable your own account")
        }

        // Prevent disabling super admin
        const targetUser = await prisma.user.findUnique({
            where: { id }
        })

        if (targetUser?.email === 'admin@localhost') {
            return badRequest("Cannot disable super admin")
        }

        const user = await prisma.user.update({
            where: {
                id
            },
            data: {
                isActive
            }
        })

        return NextResponse.json(user)
    } catch (error) {
        logger.error({ error }, 'Error updating user');
        return internalError("Failed to update user")
    }
}

export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const auth = await getAdminUser()
    if (!auth.ok) return auth.response

    try {
        // Prevent deleting self
        if (id === auth.user.id) {
            return badRequest("Cannot delete your own account")
        }

        // Prevent deleting super admin
        const targetUser = await prisma.user.findUnique({
            where: { id }
        })

        if (targetUser?.role === 'admin') {
            if (targetUser.email === 'admin@localhost') {
                return badRequest("Cannot delete super admin")
            }
        }

        const user = await prisma.user.delete({
            where: {
                id
            }
        })

        // 清理被删用户的落盘图片
        deleteUserImages(id)

        return NextResponse.json(user)
    } catch (error) {
        logger.error({ error }, 'Error deleting user');
        return internalError("Failed to delete user")
    }
}
