/**
 * /api/admin/users API 集成测试
 * 测试管理员用户管理接口
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { unauthorized, forbidden } from '@/lib/api-errors';

// Use vi.hoisted to ensure mocks are initialized before module imports
const mocks = vi.hoisted(() => ({
    mockPrismaUser: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
    mockSession: {
        user: {
            id: 'admin-id',
            email: 'admin@localhost',
            role: 'admin',
        },
        expires: '2025-12-31',
    },
    mockGetAdminUser: vi.fn(),
}));

// Mock Prisma client
vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: mocks.mockPrismaUser,
    },
}));

// Mock next-auth
vi.mock('next-auth', () => ({
    getServerSession: vi.fn(() => Promise.resolve(mocks.mockSession)),
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {},
}));

// Mock server-auth: admin 路由统一通过 getAdminUser 鉴权
vi.mock('@/lib/server-auth', () => ({
    getAdminUser: mocks.mockGetAdminUser,
    getCurrentUser: mocks.mockGetAdminUser,
}));

// Import after mocks
import { GET } from '@/app/api/admin/users/route';
import { PATCH, DELETE } from '@/app/api/admin/users/[id]/route';

const adminUser = {
    id: 'admin-id',
    email: 'admin@localhost',
    name: 'Admin',
    role: 'admin',
    isActive: true,
    mustChangePassword: false,
    educationStage: 'junior_high',
    enrollmentYear: 2024,
};

describe('/api/admin/users', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset to admin by default
        mocks.mockGetAdminUser.mockResolvedValue({ ok: true, user: adminUser });
    });

    describe('GET /api/admin/users', () => {
        it('应该返回所有用户列表', async () => {
            const mockUsers = [
                {
                    id: 'user-1',
                    name: 'User 1',
                    email: 'user1@example.com',
                    role: 'user',
                    isActive: true,
                    createdAt: new Date(),
                    _count: { errorItems: 5, practiceRecords: 10 },
                },
                {
                    id: 'user-2',
                    name: 'User 2',
                    email: 'user2@example.com',
                    role: 'user',
                    isActive: false,
                    createdAt: new Date(),
                    _count: { errorItems: 0, practiceRecords: 0 },
                },
            ];
            mocks.mockPrismaUser.findMany.mockResolvedValue(mockUsers);

            const response = await GET();
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data).toHaveLength(2);
            expect(data[0].email).toBe('user1@example.com');
        });

        it('应该拒绝非管理员访问', async () => {
            mocks.mockGetAdminUser.mockResolvedValue({ ok: false, response: forbidden("Admin role required") });

            const response = await GET();

            expect(response.status).toBe(403);
        });

        it('应该拒绝未登录用户', async () => {
            mocks.mockGetAdminUser.mockResolvedValue({ ok: false, response: unauthorized("Authentication required") });

            const response = await GET();

            expect(response.status).toBe(401);
        });
    });

    describe('PATCH /api/admin/users/[id]', () => {
        it('应该成功禁用用户', async () => {
            const targetUser = {
                id: 'target-user-id',
                email: 'user@example.com',
                isActive: false,
            };
            mocks.mockPrismaUser.findUnique.mockResolvedValue(targetUser);
            mocks.mockPrismaUser.update.mockResolvedValue({ ...targetUser, isActive: false });

            const request = new Request('http://localhost/api/admin/users/target-user-id', {
                method: 'PATCH',
                body: JSON.stringify({ isActive: false }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH(request, { params: Promise.resolve({ id: 'target-user-id' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.isActive).toBe(false);
        });

        it('应该成功启用用户', async () => {
            const targetUser = {
                id: 'target-user-id',
                email: 'user@example.com',
                isActive: true,
            };
            mocks.mockPrismaUser.findUnique.mockResolvedValue(targetUser);
            mocks.mockPrismaUser.update.mockResolvedValue({ ...targetUser, isActive: true });

            const request = new Request('http://localhost/api/admin/users/target-user-id', {
                method: 'PATCH',
                body: JSON.stringify({ isActive: true }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH(request, { params: Promise.resolve({ id: 'target-user-id' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.isActive).toBe(true);
        });

        it('应该阻止禁用自己', async () => {
            const request = new Request('http://localhost/api/admin/users/admin-id', {
                method: 'PATCH',
                body: JSON.stringify({ isActive: false }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH(request, { params: Promise.resolve({ id: 'admin-id' }) });

            expect(response.status).toBe(400);
            const data = await response.json();
            expect(data.message).toBe('Cannot disable your own account');
        });

        it('应该阻止禁用超级管理员', async () => {
            const superAdmin = {
                id: 'super-admin-id',
                email: 'admin@localhost',
            };
            mocks.mockPrismaUser.findUnique.mockResolvedValue(superAdmin);

            // 使用另一个管理员身份尝试禁用超级管理员
            mocks.mockGetAdminUser.mockResolvedValue({
                ok: true,
                user: { ...adminUser, id: 'another-admin-id', email: 'admin2@example.com' },
            });

            const request = new Request('http://localhost/api/admin/users/super-admin-id', {
                method: 'PATCH',
                body: JSON.stringify({ isActive: false }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH(request, { params: Promise.resolve({ id: 'super-admin-id' }) });

            expect(response.status).toBe(400);
            const data = await response.json();
            expect(data.message).toBe('Cannot disable super admin');
        });

        it('应该拒绝非管理员访问', async () => {
            mocks.mockGetAdminUser.mockResolvedValue({ ok: false, response: forbidden("Admin role required") });

            const request = new Request('http://localhost/api/admin/users/target-id', {
                method: 'PATCH',
                body: JSON.stringify({ isActive: false }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH(request, { params: Promise.resolve({ id: 'target-id' }) });

            expect(response.status).toBe(403);
        });
    });

    describe('DELETE /api/admin/users/[id]', () => {
        it('应该成功删除用户', async () => {
            const targetUser = {
                id: 'target-user-id',
                email: 'user@example.com',
                role: 'user',
            };
            mocks.mockPrismaUser.findUnique.mockResolvedValue(targetUser);
            mocks.mockPrismaUser.delete.mockResolvedValue(targetUser);

            const request = new Request('http://localhost/api/admin/users/target-user-id', {
                method: 'DELETE',
            });

            const response = await DELETE(request, { params: Promise.resolve({ id: 'target-user-id' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.email).toBe('user@example.com');
        });

        it('应该阻止删除自己', async () => {
            const request = new Request('http://localhost/api/admin/users/admin-id', {
                method: 'DELETE',
            });

            const response = await DELETE(request, { params: Promise.resolve({ id: 'admin-id' }) });

            expect(response.status).toBe(400);
            const data = await response.json();
            expect(data.message).toBe('Cannot delete your own account');
        });

        it('应该阻止删除超级管理员', async () => {
            const superAdmin = {
                id: 'super-admin-id',
                email: 'admin@localhost',
                role: 'admin',
            };
            mocks.mockPrismaUser.findUnique.mockResolvedValue(superAdmin);

            // 使用另一个管理员身份
            mocks.mockGetAdminUser.mockResolvedValue({
                ok: true,
                user: { ...adminUser, id: 'another-admin-id', email: 'admin2@example.com' },
            });

            const request = new Request('http://localhost/api/admin/users/super-admin-id', {
                method: 'DELETE',
            });

            const response = await DELETE(request, { params: Promise.resolve({ id: 'super-admin-id' }) });

            expect(response.status).toBe(400);
            const data = await response.json();
            expect(data.message).toBe('Cannot delete super admin');
        });

        it('应该允许删除其他普通管理员', async () => {
            const otherAdmin = {
                id: 'other-admin-id',
                email: 'admin2@example.com',
                role: 'admin',
            };
            mocks.mockPrismaUser.findUnique.mockResolvedValue(otherAdmin);
            mocks.mockPrismaUser.delete.mockResolvedValue(otherAdmin);

            const request = new Request('http://localhost/api/admin/users/other-admin-id', {
                method: 'DELETE',
            });

            const response = await DELETE(request, { params: Promise.resolve({ id: 'other-admin-id' }) });

            expect(response.status).toBe(200);
        });

        it('应该拒绝非管理员访问', async () => {
            mocks.mockGetAdminUser.mockResolvedValue({ ok: false, response: forbidden("Admin role required") });

            const request = new Request('http://localhost/api/admin/users/target-id', {
                method: 'DELETE',
            });

            const response = await DELETE(request, { params: Promise.resolve({ id: 'target-id' }) });

            expect(response.status).toBe(403);
        });
    });
});
