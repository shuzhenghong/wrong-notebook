"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { frontendLogger } from "@/lib/frontend-logger";
import { UserProfile, UpdateUserProfileRequest } from "@/types/api";

interface ProfileFormState {
    name: string;
    email: string;
    educationStage: string;
    enrollmentYear: string | number;
    password: string;
    currentPassword: string;
}

export function AccountSettings() {
    const { t } = useLanguage();
    const [profile, setProfile] = useState<ProfileFormState>({
        name: "",
        email: "",
        educationStage: "",
        enrollmentYear: "",
        password: "",
        currentPassword: ""
    });
    const [confirmPassword, setConfirmPassword] = useState("");
    const [profileLoading, setProfileLoading] = useState(false);
    const [profileSaving, setProfileSaving] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);

    useEffect(() => {
        fetchProfile();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const fetchProfile = async () => {
        setProfileLoading(true);
        try {
            const data = await apiClient.get<UserProfile>("/api/user");
            setProfile({
                name: data.name || "",
                email: data.email || "",
                educationStage: data.educationStage || "",
                enrollmentYear: data.enrollmentYear || "",
                password: "",
                currentPassword: ""
            });
        } catch (error) {
            frontendLogger.error('[AccountSettings]', 'Failed to fetch profile', { error: error instanceof Error ? error.message : String(error) });
        } finally {
            setProfileLoading(false);
        }
    };

    const handleSaveProfile = async () => {
        setProfileSaving(true);
        try {
            // 验证密码一致性（如果用户输入了密码）
            if (profile.password && profile.password !== confirmPassword) {
                alert(t.settings?.messages?.passwordMismatch || 'Passwords do not match');
                setProfileSaving(false);
                return;
            }

            const payload: UpdateUserProfileRequest = {
                name: profile.name,
                email: profile.email,
                educationStage: profile.educationStage,
            };

            if (profile.enrollmentYear) {
                payload.enrollmentYear = parseInt(profile.enrollmentYear.toString());
            }

            if (profile.password) {
                if (profile.password.length < 8) {
                    alert(t.settings?.account?.passwordTooShort || 'Password must be at least 8 characters');
                    setProfileSaving(false);
                    return;
                }
                payload.password = profile.password;
                // 安全要求：改密必须提供当前密码（服务端会做 bcrypt 校验）
                payload.currentPassword = profile.currentPassword;
            }

            await apiClient.patch("/api/user", payload);

            alert(t.settings?.messages?.profileUpdated || "Profile updated");
            setProfile(prev => ({ ...prev, password: "", currentPassword: "" })); // Clear password fields
            setConfirmPassword(""); // Clear confirm password field
            setShowPassword(false);
            setShowConfirmPassword(false);
            window.location.reload(); // Reload to update user name in UI
        } catch (error: any) {
            frontendLogger.error('[AccountSettings]', 'Failed to update profile', { error: error?.data?.message || error?.message || String(error) });
            const message = error.data?.message || (t.settings?.messages?.updateFailed || "Update failed");
            alert(message);
        } finally {
            setProfileSaving(false);
        }
    };

    return (
        <div className="space-y-4 py-4">
            {profileLoading ? (
                <div className="flex justify-center py-8">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
            ) : (
                <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label>{t.auth?.name || "Name"}</Label>
                            <Input
                                value={profile.name || ""}
                                onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>{t.auth?.email || "Email"}</Label>
                            <Input
                                value={profile.email || ""}
                                onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                                type="email"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label>{t.auth?.educationStage || "Education Stage"}</Label>
                            <Select
                                value={profile.educationStage || ""}
                                onValueChange={(val) => setProfile({ ...profile, educationStage: val })}
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder={t.auth?.selectStage || "Select Stage"} />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="primary">{t.auth?.primary || 'Primary School'}</SelectItem>
                                    <SelectItem value="junior_high">{t.auth?.juniorHigh || 'Junior High'}</SelectItem>
                                    <SelectItem value="senior_high">{t.auth?.seniorHigh || 'Senior High'}</SelectItem>
                                    <SelectItem value="university">{t.auth?.university || 'University'}</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label>{t.auth?.enrollmentYear || "Enrollment Year"}</Label>
                            <Input
                                type="number"
                                value={profile.enrollmentYear || ""}
                                onChange={(e) => setProfile({ ...profile, enrollmentYear: e.target.value })}
                                placeholder="YYYY"
                            />
                        </div>
                    </div>

                    <div className="space-y-3 pt-2 border-t">
                        {profile.password && (
                            <div className="space-y-2">
                                <Label>{t.settings?.account?.currentPassword || "Current Password (required to change password)"}</Label>
                                <Input
                                    type="password"
                                    value={profile.currentPassword}
                                    onChange={(e) => setProfile({ ...profile, currentPassword: e.target.value })}
                                    placeholder="******"
                                    autoComplete="current-password"
                                />
                            </div>
                        )}
                        <div className="space-y-2">
                            <Label>{t.settings?.account?.changePassword || "Change Password (Leave empty to keep)"}</Label>
                            <div className="relative">
                                <Input
                                    type={showPassword ? "text" : "password"}
                                    value={profile.password}
                                    onChange={(e) => setProfile({ ...profile, password: e.target.value })}
                                    placeholder="******"
                                    minLength={8}
                                    className="pr-10"
                                />
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                                    onClick={() => setShowPassword(!showPassword)}
                                    tabIndex={-1}
                                >
                                    {showPassword ? (
                                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                                    ) : (
                                        <Eye className="h-4 w-4 text-muted-foreground" />
                                    )}
                                </Button>
                            </div>
                        </div>
                        {profile.password && (
                            <div className="space-y-2">
                                <Label>{t.auth?.confirmPassword || "Confirm Password"}</Label>
                                <div className="relative">
                                    <Input
                                        type={showConfirmPassword ? "text" : "password"}
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        placeholder="******"
                                        minLength={8}
                                        className="pr-10"
                                    />
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                                        tabIndex={-1}
                                    >
                                        {showConfirmPassword ? (
                                            <EyeOff className="h-4 w-4 text-muted-foreground" />
                                        ) : (
                                            <Eye className="h-4 w-4 text-muted-foreground" />
                                        )}
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>

                    <Button onClick={handleSaveProfile} disabled={profileSaving} className="w-full">
                        {profileSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {t.settings?.account?.update || "Update Profile"}
                    </Button>
                </div>
            )}
        </div>
    );
}
