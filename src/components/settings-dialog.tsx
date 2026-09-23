"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Settings, AlertTriangle, Languages, User, Bot, Shield } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { UserManagement } from "@/components/admin/user-management";
import { apiClient } from "@/lib/api-client";
import { frontendLogger } from "@/lib/frontend-logger";
import { AppConfig } from "@/types/api";
import { PromptSettings } from "@/components/settings/prompt-settings";
import { GeneralSettings } from "@/components/settings/general-settings";
import { AccountSettings } from "@/components/settings/account-settings";
import { AiSettings } from "@/components/settings/ai-settings";
import { DangerZoneSettings } from "@/components/settings/danger-zone";
import { AboutSettings } from "@/components/settings/about-settings";
import { MessageSquareText, Info, BarChart3 } from "lucide-react";

export function SettingsDialog() {
    const { data: session } = useSession();
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    const dialogContentRef = useRef<HTMLDivElement>(null);
    const [saving, setSaving] = useState(false);
    const [loading, setLoading] = useState(false);
    const [config, setConfig] = useState<AppConfig>({ aiProvider: 'gemini' });

    const router = useRouter();
    const isAdmin = (session?.user as any)?.role === 'admin';

    useEffect(() => {
        if (open) {
            fetchSettings();
        }
    }, [open]);

    const fetchSettings = async () => {
        setLoading(true);
        try {
            const data = await apiClient.get<AppConfig>("/api/settings");
            setConfig(data);
        } catch (error) {
            frontendLogger.error('[SettingsDialog]', 'Failed to fetch settings', { error: error instanceof Error ? error.message : String(error) });
        } finally {
            setLoading(false);
        }
    };

    // 验证 OpenAI 实例必填字段
    const validateOpenAIInstances = (): string | null => {
        if (config.aiProvider !== 'openai') return null;
        const instances = config.openai?.instances || [];
        for (const instance of instances) {
            if (!instance.name?.trim()) {
                return t.settings?.ai?.validationNameRequired || '实例名称不能为空';
            }
            if (!instance.apiKey?.trim()) {
                return t.settings?.ai?.validationApiKeyRequired || 'API Key 不能为空';
            }
            if (!instance.baseUrl?.trim()) {
                return t.settings?.ai?.validationBaseUrlRequired || 'Base URL 不能为空';
            }
            if (!instance.model?.trim()) {
                return t.settings?.ai?.validationModelRequired || '模型名称不能为空';
            }
        }
        return null;
    };

    // 验证 Azure OpenAI 必填字段
    const validateAzureConfig = (): string | null => {
        if (config.aiProvider !== 'azure') return null;
        if (!config.azure?.endpoint?.trim()) {
            return t.settings?.ai?.validationAzureEndpointRequired || 'Azure Endpoint is required';
        }
        if (!config.azure?.deploymentName?.trim()) {
            return t.settings?.ai?.validationAzureDeploymentRequired || 'Deployment Name is required';
        }
        if (!config.azure?.apiKey?.trim()) {
            return t.settings?.ai?.validationApiKeyRequired || 'API Key is required';
        }
        return null;
    };

    const handleSaveSettings = async () => {
        // 验证 OpenAI 实例必填字段
        const openaiValidationError = validateOpenAIInstances();
        if (openaiValidationError) {
            alert(openaiValidationError);
            return;
        }

        // 验证 Azure 必填字段
        const azureValidationError = validateAzureConfig();
        if (azureValidationError) {
            alert(azureValidationError);
            return;
        }

        setSaving(true);
        try {
            await apiClient.post("/api/settings", config);
            alert(t.settings?.messages?.saved || "Settings saved");
            // 保存成功后滚动到顶部，方便关闭对话框
            dialogContentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
        } catch (error) {
            frontendLogger.error('[SettingsDialog]', 'Failed to save settings', { error: error instanceof Error ? error.message : String(error) });
            alert(t.settings?.messages?.saveFailed || "Failed to save");
        } finally {
            setSaving(false);
        }
    };

    const updatePrompts = (type: 'analyze' | 'similar', value: string) => {
        setConfig(prev => ({
            ...prev,
            prompts: {
                ...prev.prompts,
                [type]: value
            }
        }));
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full">
                    <Settings className="h-5 w-5" />
                    <span className="sr-only">{t.settings?.title || "Settings"}</span>
                </Button>
            </DialogTrigger>
            <DialogContent ref={dialogContentRef} className="w-[calc(100vw-2rem)] sm:max-w-[900px] max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{t.settings?.title || "Settings"}</DialogTitle>
                    <DialogDescription>
                        {t.settings?.desc || 'Manage your preferences and data.'}
                    </DialogDescription>
                </DialogHeader>

                <Tabs defaultValue="general" className="w-full">
                    <TabsList className={`grid w-full grid-cols-4 ${isAdmin ? 'sm:grid-cols-7' : 'sm:grid-cols-4'} gap-1 h-auto`}>
                        <TabsTrigger value="general" className="px-2 sm:px-3">
                            <Languages className="h-4 w-4 sm:mr-2" />
                            <span className="hidden sm:inline">{t.settings?.tabs?.general || "General"}</span>
                        </TabsTrigger>
                        <TabsTrigger value="account" className="px-2 sm:px-3">
                            <User className="h-4 w-4 sm:mr-2" />
                            <span className="hidden sm:inline">{t.settings?.tabs?.account || "Account"}</span>
                        </TabsTrigger>
                        {isAdmin && (
                            <>
                                <TabsTrigger value="ai" className="px-2 sm:px-3">
                                    <Bot className="h-4 w-4 sm:mr-2" />
                                    <span className="hidden sm:inline">{t.settings?.tabs?.ai || "AI Provider"}</span>
                                </TabsTrigger>
                                <TabsTrigger value="prompts" className="px-2 sm:px-3">
                                    <MessageSquareText className="h-4 w-4 sm:mr-2" />
                                    <span className="hidden sm:inline">{t.settings?.tabs?.prompts || "Prompts"}</span>
                                </TabsTrigger>
                                <TabsTrigger value="admin" className="px-2 sm:px-3">
                                    <Shield className="h-4 w-4 sm:mr-2" />
                                    <span className="hidden sm:inline">{t.settings?.tabs?.admin || "User Management"}</span>
                                </TabsTrigger>
                            </>
                        )}
                        <TabsTrigger value="danger" className="px-2 sm:px-3">
                            <AlertTriangle className="h-4 w-4 sm:mr-2" />
                            <span className="hidden sm:inline">{t.settings?.tabs?.danger || "Danger"}</span>
                        </TabsTrigger>
                        <TabsTrigger value="about" className="px-2 sm:px-3">
                            <Info className="h-4 w-4 sm:mr-2" />
                            <span className="hidden sm:inline">{t.settings?.tabs?.about || "About"}</span>
                        </TabsTrigger>
                    </TabsList>

                    {/* General Tab */}
                    <TabsContent value="general">
                        <GeneralSettings
                            config={config}
                            setConfig={setConfig}
                            saving={saving}
                            onSave={handleSaveSettings}
                        />
                    </TabsContent>

                    {/* Account Tab */}
                    <TabsContent value="account">
                        <AccountSettings />
                    </TabsContent>

                    {/* AI Tab */}
                    {isAdmin && (
                        <TabsContent value="ai">
                            {loading ? (
                                <div className="flex justify-center py-4">
                                    <span className="animate-spin inline-block w-6 h-6 border-2 border-muted-foreground border-t-transparent rounded-full" role="status" aria-label="loading" />
                                </div>
                            ) : (
                                <AiSettings
                                    config={config}
                                    setConfig={setConfig}
                                    saving={saving}
                                    onSave={handleSaveSettings}
                                />
                            )}
                        </TabsContent>
                    )}

                    {/* Prompts Tab */}
                    {isAdmin && (
                        <TabsContent value="prompts" className="space-y-4 py-4">
                            <PromptSettings config={config} onUpdate={updatePrompts} />
                            <Button onClick={handleSaveSettings} disabled={saving} className="w-full">
                                {saving && <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
                                {t.settings?.prompts?.save || "Save Prompt Settings"}
                            </Button>
                        </TabsContent>
                    )}

                    {/* Admin Tab */}
                    {isAdmin && (
                        <TabsContent value="admin" className="space-y-4 py-4">
                            <Button
                                variant="outline"
                                className="w-full justify-start gap-2"
                                onClick={() => {
                                    setOpen(false)
                                    router.push("/admin")
                                }}
                            >
                                <BarChart3 className="h-4 w-4" />
                                {t.admin?.dashboard?.title || "Admin Dashboard"}
                            </Button>
                            <div className="border-t pt-4">
                                <UserManagement />
                            </div>
                        </TabsContent>
                    )}

                    {/* Danger Zone Tab */}
                    <TabsContent value="danger">
                        <DangerZoneSettings onClose={() => setOpen(false)} />
                    </TabsContent>

                    {/* About Tab */}
                    <TabsContent value="about">
                        <AboutSettings />
                    </TabsContent>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
}
