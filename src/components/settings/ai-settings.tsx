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
import { Trash2, Loader2, Eye, EyeOff, Plus, Zap, CheckCircle2, XCircle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { frontendLogger } from "@/lib/frontend-logger";
import { AppConfig, OpenAIInstance } from "@/types/api";
import { ModelSelector } from "@/components/ui/model-selector";

const MAX_OPENAI_INSTANCES = 10;

// 生成唯一 ID
function generateId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

interface AiSettingsProps {
    config: AppConfig;
    setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
    saving: boolean;
    /** 保存整个 config（由外层 SettingsDialog 统一校验并提交） */
    onSave: () => void;
}

export function AiSettings({ config, setConfig, saving, onSave }: AiSettingsProps) {
    const { t, language } = useLanguage();
    const [showApiKey, setShowApiKey] = useState(false);
    const [selectedInstanceId, setSelectedInstanceId] = useState<string | undefined>(undefined);

    // AI 连接测试状态
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{
        success: boolean;
        textSupport: boolean;
        visionSupport: boolean;
        textError?: string;
        visionError?: string;
        modelInfo?: string;
    } | null>(null);

    const updateConfig = (section: 'openai' | 'gemini', key: string, value: string) => {
        if (section === 'gemini') {
            setConfig(prev => ({
                ...prev,
                gemini: {
                    ...prev.gemini,
                    [key]: value
                }
            }));
        }
        // OpenAI 配置更新通过 updateOpenAIInstance 处理
    };

    // 获取当前选中的 OpenAI 实例
    const getSelectedInstance = (): OpenAIInstance | undefined => {
        const instances = config.openai?.instances || [];
        const activeId = selectedInstanceId || config.openai?.activeInstanceId;
        return instances.find(i => i.id === activeId);
    };

    // 更新当前选中的 OpenAI 实例属性
    const updateOpenAIInstance = (key: keyof OpenAIInstance, value: string) => {
        const instances = config.openai?.instances || [];
        const activeId = selectedInstanceId || config.openai?.activeInstanceId;
        const updatedInstances = instances.map(instance =>
            instance.id === activeId ? { ...instance, [key]: value } : instance
        );
        setConfig(prev => ({
            ...prev,
            openai: {
                ...prev.openai,
                instances: updatedInstances,
            }
        }));
    };

    // 添加新的 OpenAI 实例
    const addOpenAIInstance = () => {
        const instances = config.openai?.instances || [];
        if (instances.length >= MAX_OPENAI_INSTANCES) return;

        const newInstance: OpenAIInstance = {
            id: generateId(),
            name: `Instance ${instances.length + 1}`,
            apiKey: '',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o',
        };

        setConfig(prev => ({
            ...prev,
            openai: {
                instances: [...(prev.openai?.instances || []), newInstance],
                activeInstanceId: newInstance.id,
            }
        }));
        setSelectedInstanceId(newInstance.id);
    };

    // 删除 OpenAI 实例
    const deleteOpenAIInstance = (instanceId: string) => {
        const instances = config.openai?.instances || [];
        const updatedInstances = instances.filter(i => i.id !== instanceId);
        const newActiveId = updatedInstances.length > 0 ? updatedInstances[0].id : undefined;

        setConfig(prev => ({
            ...prev,
            openai: {
                instances: updatedInstances,
                activeInstanceId: newActiveId,
            }
        }));
        setSelectedInstanceId(newActiveId);
    };

    // 切换激活的 OpenAI 实例
    const setActiveOpenAIInstance = (instanceId: string) => {
        setSelectedInstanceId(instanceId);
        setConfig(prev => ({
            ...prev,
            openai: {
                ...prev.openai,
                activeInstanceId: instanceId,
            }
        }));
    };

    // 同步 selectedInstanceId 与 config
    useEffect(() => {
        if (config.openai?.activeInstanceId && !selectedInstanceId) {
            setSelectedInstanceId(config.openai.activeInstanceId);
        }
    }, [config.openai?.activeInstanceId, selectedInstanceId]);

    // 测试 AI 连接
    const handleTestConnection = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            let requestBody: Record<string, unknown>;
            if (config.aiProvider === 'openai') {
                const instance = getSelectedInstance();
                if (!instance?.apiKey) {
                    setTestResult({ success: false, textSupport: false, visionSupport: false, textError: t.settings?.ai?.validationApiKeyRequired || 'API Key is required' });
                    setTesting(false);
                    return;
                }
                requestBody = {
                    provider: 'openai',
                    apiKey: instance.apiKey,
                    baseUrl: instance.baseUrl,
                    model: instance.model,
                    language: language
                };
            } else if (config.aiProvider === 'gemini') {
                if (!config.gemini?.apiKey) {
                    setTestResult({ success: false, textSupport: false, visionSupport: false, textError: t.settings?.ai?.validationApiKeyRequired || 'API Key is required' });
                    setTesting(false);
                    return;
                }
                requestBody = {
                    provider: 'gemini',
                    apiKey: config.gemini.apiKey,
                    baseUrl: config.gemini.baseUrl,
                    model: config.gemini.model,
                    language: language
                };
            } else if (config.aiProvider === 'azure') {
                if (!config.azure?.apiKey || !config.azure?.endpoint || !config.azure?.deploymentName) {
                    setTestResult({ success: false, textSupport: false, visionSupport: false, textError: t.settings?.ai?.validationAzureEndpointRequired || 'Azure config is incomplete' });
                    setTesting(false);
                    return;
                }
                requestBody = {
                    provider: 'azure',
                    apiKey: config.azure.apiKey,
                    endpoint: config.azure.endpoint,
                    deploymentName: config.azure.deploymentName,
                    apiVersion: config.azure.apiVersion,
                    model: config.azure.model,
                    language: language
                };
            } else {
                setTesting(false);
                return;
            }

            const response = await apiClient.post<{
                success: boolean;
                textSupport: boolean;
                visionSupport: boolean;
                textError?: string;
                visionError?: string;
                modelInfo?: string;
            }>('/api/ai/test', requestBody);

            setTestResult(response);
        } catch (error) {
            frontendLogger.error('[AiSettings]', 'AI connection test failed', { error: error instanceof Error ? error.message : String(error) });
            setTestResult({
                success: false,
                textSupport: false,
                visionSupport: false,
                textError: error instanceof Error ? error.message : String(error)
            });
        } finally {
            setTesting(false);
        }
    };

    return (
        <div className="space-y-4 py-4">
            <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
                <div className="space-y-2">
                    <Label>{t.settings?.tabs?.ai || "AI Provider"}</Label>
                    <Select
                        value={config.aiProvider}
                        onValueChange={(val: 'gemini' | 'openai' | 'azure') => setConfig(prev => ({ ...prev, aiProvider: val }))}
                    >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="gemini">Google Gemini</SelectItem>
                            <SelectItem value="openai">OpenAI / Compatible</SelectItem>
                            <SelectItem value="azure">Azure OpenAI</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                {config.aiProvider === 'openai' && (
                    <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
                        {/* 实例选择器 */}
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <Label>{t.settings?.ai?.instances || "Instance"}</Label>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={addOpenAIInstance}
                                    disabled={(config.openai?.instances?.length || 0) >= MAX_OPENAI_INSTANCES}
                                    className="h-7 px-2 text-xs"
                                >
                                    <Plus className="h-3 w-3 mr-1" />
                                    {t.settings?.ai?.addInstance || "Add"}
                                </Button>
                            </div>
                            {(config.openai?.instances?.length || 0) > 0 ? (
                                <div className="flex gap-2">
                                    <Select
                                        value={selectedInstanceId || config.openai?.activeInstanceId || ''}
                                        onValueChange={setActiveOpenAIInstance}
                                    >
                                        <SelectTrigger className="flex-1">
                                            <SelectValue placeholder={t.settings?.ai?.selectInstance || "Select Instance"} />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {(config.openai?.instances || []).map((instance) => (
                                                <SelectItem key={instance.id} value={instance.id}>
                                                    {instance.name}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    {(config.openai?.instances?.length || 0) > 1 && (
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="icon"
                                            onClick={() => {
                                                const activeId = selectedInstanceId || config.openai?.activeInstanceId;
                                                if (activeId && confirm(t.settings?.ai?.confirmDelete || 'Delete this instance?')) {
                                                    deleteOpenAIInstance(activeId);
                                                }
                                            }}
                                            className="h-10 w-10 text-destructive hover:text-destructive"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    )}
                                </div>
                            ) : (
                                <p className="text-sm text-muted-foreground">
                                    {t.settings?.ai?.noInstances || "No instances configured. Click 'Add' to create one."}
                                </p>
                            )}
                            {(config.openai?.instances?.length || 0) >= MAX_OPENAI_INSTANCES && (
                                <p className="text-xs text-amber-600">
                                    {t.settings?.ai?.maxInstancesReached || "Maximum instances reached (10)"}
                                </p>
                            )}
                        </div>

                        {/* 实例配置表单 */}
                        {getSelectedInstance() && (
                            <div className="space-y-3 p-3 border rounded-md bg-background">
                                <div className="space-y-2">
                                    <Label>{t.settings?.ai?.instanceName || "Instance Name"} <span className="text-destructive">*</span></Label>
                                    <Input
                                        value={getSelectedInstance()?.name || ''}
                                        onChange={(e) => updateOpenAIInstance('name', e.target.value)}
                                        placeholder="e.g. 智谱 GLM-4V"
                                        className={!getSelectedInstance()?.name?.trim() ? 'border-destructive' : ''}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>API Key <span className="text-destructive">*</span></Label>
                                    <div className="relative">
                                        <Input
                                            type={showApiKey ? "text" : "password"}
                                            value={getSelectedInstance()?.apiKey || ''}
                                            onChange={(e) => updateOpenAIInstance('apiKey', e.target.value)}
                                            placeholder="sk-..."
                                            className={`pr-10 ${!getSelectedInstance()?.apiKey?.trim() ? 'border-destructive' : ''}`}
                                        />
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                                            onClick={() => setShowApiKey(!showApiKey)}
                                        >
                                            {showApiKey ? (
                                                <EyeOff className="h-4 w-4 text-muted-foreground" />
                                            ) : (
                                                <Eye className="h-4 w-4 text-muted-foreground" />
                                            )}
                                        </Button>
                                    </div>
                                </div>
                                <div className="space-y-2 pt-4 border-t">
                                    <Label>Base URL <span className="text-destructive">*</span></Label>
                                    <Input
                                        value={getSelectedInstance()?.baseUrl || ''}
                                        onChange={(e) => updateOpenAIInstance('baseUrl', e.target.value)}
                                        placeholder="https://api.openai.com/v1"
                                        className={!getSelectedInstance()?.baseUrl?.trim() ? 'border-destructive' : ''}
                                    />
                                </div>
                                <ModelSelector
                                    provider="openai"
                                    apiKey={getSelectedInstance()?.apiKey}
                                    baseUrl={getSelectedInstance()?.baseUrl}
                                    currentModel={getSelectedInstance()?.model}
                                    onModelChange={(model) => updateOpenAIInstance('model', model)}
                                />
                            </div>
                        )}
                    </div>
                )}

                {config.aiProvider === 'gemini' && (
                    <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
                        <div className="space-y-2">
                            <Label>API Key</Label>
                            <div className="relative">
                                <Input
                                    type={showApiKey ? "text" : "password"}
                                    value={config.gemini?.apiKey || ''}
                                    onChange={(e) => updateConfig('gemini', 'apiKey', e.target.value)}
                                    placeholder="AIza..."
                                    className="pr-10"
                                />
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                                    onClick={() => setShowApiKey(!showApiKey)}
                                >
                                    {showApiKey ? (
                                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                                    ) : (
                                        <Eye className="h-4 w-4 text-muted-foreground" />
                                    )}
                                </Button>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label>Base URL (Optional)</Label>
                            <Input
                                value={config.gemini?.baseUrl || ''}
                                onChange={(e) => updateConfig('gemini', 'baseUrl', e.target.value)}
                                placeholder="https://generativelanguage.googleapis.com"
                            />
                        </div>
                        <ModelSelector
                            provider="gemini"
                            apiKey={config.gemini?.apiKey}
                            baseUrl={config.gemini?.baseUrl}
                            currentModel={config.gemini?.model}
                            onModelChange={(model) => updateConfig('gemini', 'model', model)}
                        />
                    </div>
                )}

                {config.aiProvider === 'azure' && (
                    <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
                        <div className="space-y-2">
                            <Label>{t.settings?.ai?.azureEndpoint || "Azure Endpoint"} <span className="text-destructive">*</span></Label>
                            <Input
                                value={config.azure?.endpoint || ''}
                                onChange={(e) => setConfig(prev => ({ ...prev, azure: { ...prev.azure, endpoint: e.target.value } }))}
                                placeholder={t.settings?.ai?.azureEndpointPlaceholder || "https://your-resource.openai.azure.com"}
                                className={!config.azure?.endpoint?.trim() ? 'border-destructive' : ''}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>{t.settings?.ai?.azureDeployment || "Deployment Name"} <span className="text-destructive">*</span></Label>
                            <Input
                                value={config.azure?.deploymentName || ''}
                                onChange={(e) => setConfig(prev => ({ ...prev, azure: { ...prev.azure, deploymentName: e.target.value } }))}
                                placeholder={t.settings?.ai?.azureDeploymentPlaceholder || "gpt-4o-deployment"}
                                className={!config.azure?.deploymentName?.trim() ? 'border-destructive' : ''}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>API Key <span className="text-destructive">*</span></Label>
                            <div className="relative">
                                <Input
                                    type={showApiKey ? "text" : "password"}
                                    value={config.azure?.apiKey || ''}
                                    onChange={(e) => setConfig(prev => ({ ...prev, azure: { ...prev.azure, apiKey: e.target.value } }))}
                                    placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                                    className={`pr-10 ${!config.azure?.apiKey?.trim() ? 'border-destructive' : ''}`}
                                />
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                                    onClick={() => setShowApiKey(!showApiKey)}
                                >
                                    {showApiKey ? (
                                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                                    ) : (
                                        <Eye className="h-4 w-4 text-muted-foreground" />
                                    )}
                                </Button>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label>{t.settings?.ai?.azureApiVersion || "API Version"}</Label>
                            <Input
                                value={config.azure?.apiVersion || ''}
                                onChange={(e) => setConfig(prev => ({ ...prev, azure: { ...prev.azure, apiVersion: e.target.value } }))}
                                placeholder={t.settings?.ai?.azureApiVersionPlaceholder || "2024-02-15-preview"}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>{t.settings?.ai?.azureModel || "Model Display Name"}</Label>
                            <Input
                                value={config.azure?.model || ''}
                                onChange={(e) => setConfig(prev => ({ ...prev, azure: { ...prev.azure, model: e.target.value } }))}
                                placeholder="gpt-4o"
                            />
                        </div>
                    </div>
                )}
                {/* 测试连接和保存按钮 */}
                <div className="space-y-3 pt-3 border-t">
                    <div className="flex gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={handleTestConnection}
                            disabled={testing || saving}
                            className="flex-1"
                        >
                            {testing ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                                <Zap className="mr-2 h-4 w-4" />
                            )}
                            {testing ? (t.settings?.ai?.testing || "测试中...") : (t.settings?.ai?.testConnection || "测试连接")}
                        </Button>
                        <Button onClick={onSave} disabled={saving || testing} className="flex-1">
                            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            {t.settings?.ai?.save || "Save AI Settings"}
                        </Button>
                    </div>

                    {/* 测试结果显示 */}
                    {testResult && (
                        <div className={`p-3 rounded-md text-sm ${testResult.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                            <div className="flex items-center gap-2 font-medium mb-2">
                                {testResult.success ? (
                                    <>
                                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                                        <span className="text-green-700">{t.settings?.ai?.testSuccess || "连接成功"}</span>
                                        {testResult.modelInfo && <span className="text-green-600 text-xs">({testResult.modelInfo})</span>}
                                    </>
                                ) : (
                                    <>
                                        <XCircle className="h-4 w-4 text-red-600" />
                                        <span className="text-red-700">{t.settings?.ai?.testFailed || "连接失败"}</span>
                                    </>
                                )}
                            </div>
                            {testResult.success && (
                                <div className="space-y-1 text-xs">
                                    <div className="flex items-center gap-2">
                                        <span className="text-muted-foreground">{t.settings?.ai?.textSupport || "文本生成"}:</span>
                                        <span className="text-green-600">✓ {t.settings?.ai?.supported || "支持"}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-muted-foreground">{t.settings?.ai?.visionSupport || "图像识别/多模态"}:</span>
                                        {testResult.visionSupport ? (
                                            <span className="text-green-600">✓ {t.settings?.ai?.supported || "支持"}</span>
                                        ) : (
                                            <span className="text-amber-600">✗ {
                                                testResult.visionError
                                                    ? ((t.settings?.ai?.errors as Record<string, string>)?.[testResult.visionError] || testResult.visionError.replace('UNKNOWN:', ''))
                                                    : (t.settings?.ai?.notSupported || "不支持")
                                            }</span>
                                        )}
                                    </div>
                                    <p className="text-muted-foreground/60 text-[10px] pl-1">* 由于网络问题，可能测试结果不准确</p>
                                </div>
                            )}
                            {!testResult.success && testResult.textError && (
                                <p className="text-red-600 text-xs mt-1">{
                                    (t.settings?.ai?.errors as Record<string, string>)?.[testResult.textError]
                                    || testResult.textError.replace('UNKNOWN:', '')
                                }</p>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
