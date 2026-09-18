import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { getAdminUser } from "@/lib/server-auth"
import { internalError } from "@/lib/api-errors"
import { createLogger } from "@/lib/logger"

const logger = createLogger('api:admin:users');

export async function GET() {
    const auth = await getAdminUser()
    if (!auth.ok) return auth.response

    try {
        const users = await prisma.user.findMany({
            orderBy: {
                createdAt: 'desc'
            },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                isActive: true,
                createdAt: true,
                _count: {
                    select: {
                        errorItems: true,
                        practiceRecords: true
                    }
                }
            }
        })

        return NextResponse.json(users)
    } catch (error) {
        logger.error({ error }, 'Error fetching users');
        return internalError("Failed to fetch users")
    }
}
