"use client";

import { useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";

export default function ChangePasswordPage() {
    const router = useRouter();
    const { t } = useLanguage();
    const { data: session, status } = useSession();
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (newPassword.length < 8) {
            setError(t.auth?.changePassword?.tooShort || "密码至少需要 8 位");
            return;
        }
        if (newPassword !== confirmPassword) {
            setError(t.auth?.changePassword?.passwordMismatch || "两次密码不一致");
            return;
        }

        setLoading(true);
        try {
            await apiClient.patch<unknown, { password: string }>("/api/user", {
                password: newPassword,
            });

            // 用新密码重新建立会话，刷新 JWT 里的 mustChangePassword 标记
            const email = session?.user?.email;
            if (email) {
                await signIn("credentials", { redirect: false, email, password: newPassword });
            }

            router.push("/");
            router.refresh();
        } catch (err) {
            setError(t.auth?.changePassword?.failed || "修改密码失败");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4">
            <Card className="w-full max-w-md">
                <CardHeader>
                    <CardTitle className="text-2xl text-center">
                        {t.auth?.changePassword?.title || "修改密码"}
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground mb-4 text-center">
                        {t.auth?.changePassword?.description || "当前账号使用的是初始密码，请先设置新密码。"}
                    </p>
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="space-y-2">
                            <label htmlFor="new-password" className="text-sm font-medium">
                                {t.auth?.changePassword?.newPassword || "新密码"}
                            </label>
                            <Input
                                id="new-password"
                                name="new-password"
                                type="password"
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                minLength={8}
                                required
                            />
                        </div>
                        <div className="space-y-2">
                            <label htmlFor="confirm-password" className="text-sm font-medium">
                                {t.auth?.changePassword?.confirmPassword || "确认新密码"}
                            </label>
                            <Input
                                id="confirm-password"
                                name="confirm-password"
                                type="password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                minLength={8}
                                required
                            />
                        </div>
                        {error && (
                            <div className="text-destructive text-sm text-center">{error}</div>
                        )}
                        <Button
                            type="submit"
                            className="w-full"
                            disabled={loading || status === "loading"}
                        >
                            {loading
                                ? (t.auth?.changePassword?.submitting || "提交中...")
                                : (t.auth?.changePassword?.action || "保存并继续")}
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </div>
    );
}
