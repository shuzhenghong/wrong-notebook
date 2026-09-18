import { NextAuthOptions } from "next-auth"
import { PrismaAdapter } from "@next-auth/prisma-adapter"
import CredentialsProvider from "next-auth/providers/credentials"
import { prisma } from "@/lib/prisma"
import { compare } from "bcryptjs"
import { createLogger } from "@/lib/logger"

const logger = createLogger('auth');

export const authOptions: NextAuthOptions = {
    adapter: PrismaAdapter(prisma),
    session: {
        strategy: "jwt",
    },
    // @ts-expect-error trustHost is a valid option in newer NextAuth versions but types might be lagging
    trustHost: true,
    pages: {
        signIn: "/login",
    },
    // Force using a single cookie name to avoid HTTP/HTTPS mismatches in proxy environments
    // This allows running without NEXTAUTH_URL behind Cloudflare Tunnel
    cookies: {
        sessionToken: {
            name: "next-auth.session-token",
            options: {
                httpOnly: true,
                sameSite: "lax",
                path: "/",
                // Only use secure cookies if explicitly running on HTTPS (via NEXTAUTH_URL)
                // This enables HTTP local IP access in Docker/Production if NEXTAUTH_URL is unset
                secure: process.env.NODE_ENV === "production" && process.env.NEXTAUTH_URL?.startsWith("https"),
            },
        },
    },
    providers: [
        CredentialsProvider({
            name: "Credentials",
            credentials: {
                email: { label: "Email", type: "email" },
                password: { label: "Password", type: "password" }
            },
            async authorize(credentials) {
                logger.debug({ email: credentials?.email }, 'Authorize called');
                if (!credentials?.email || !credentials?.password) {
                    logger.debug('Missing credentials');
                    return null
                }

                const user = await prisma.user.findUnique({
                    where: {
                        email: credentials.email
                    }
                })

                if (!user) {
                    logger.debug('User not found');
                    return null
                }

                // Check if user is active
                if (!user.isActive) {
                    logger.warn({ email: user.email }, 'User account is disabled, refusing login');
                    throw new Error("Account is disabled")
                }

                const isPasswordValid = await compare(credentials.password, user.password)

                if (!isPasswordValid) {
                    logger.debug('Invalid password');
                    return null
                }

                logger.info({ email: user.email }, 'Login successful');

                return {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    role: user.role,
                    // isActive 进 token，session callback 可以直接用
                    isActive: user.isActive,
                } as any
            }
        })
    ],
    // Debug logs 在开发环境开，但别在生产里刷日志
    debug: process.env.NODE_ENV !== 'production' && process.env.NEXTAUTH_DEBUG === 'true',
    logger: {
        error(code, metadata) {
            logger.error({ code, metadata }, 'NextAuth error');
        },
        warn(code) {
            logger.warn({ code }, 'NextAuth warning');
        },
        debug(code, metadata) {
            logger.debug({ code, metadata }, 'NextAuth debug');
        }
    },
    callbacks: {
        async session({ session, token }) {
            // 每次 session 回调都从 DB 确认用户是否仍然启用
            // —— 防止禁用用户继续使用已签发的 JWT
            if (token?.email) {
                try {
                    const u = await prisma.user.findUnique({
                        where: { email: token.email as string },
                        select: { isActive: true, role: true, id: true },
                    });
                    if (!u || !u.isActive) {
                        logger.warn({ email: token.email }, 'Session rejected: user missing or disabled');
                        // 返回一个空 session 让客户端视为未登录
                        return { ...session, user: {} } as any;
                    }
                    // 同步最新 role（管理员可能后台改了）
                    token.role = u.role;
                    token.id = u.id;
                    token.isActive = true;
                } catch (err) {
                    logger.warn({ error: (err as Error).message }, 'Failed to validate user on session callback');
                    // DB 连不上时宁可不放行 —— fail-closed
                    return { ...session, user: {} } as any;
                }
            }

            logger.debug({ userId: token.id }, 'Session callback');
            return {
                ...session,
                user: {
                    ...session.user,
                    id: token.id,
                    role: token.role,
                }
            }
        },
        async jwt({ token, user, account, profile }) {
            if (user) {
                logger.debug({ userId: (user as any).id }, 'JWT callback - Initial signin');
                return {
                    ...token,
                    id: (user as any).id,
                    role: (user as any).role,
                    isActive: (user as any).isActive,
                }
            }
            logger.debug('JWT callback - Subsequent call');
            return token
        }
    }
}

// Log startup check
logger.info({
    NODE_ENV: process.env.NODE_ENV,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    HAS_SECRET: !!process.env.NEXTAUTH_SECRET,
    AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST
}, 'AuthConfig loading');
