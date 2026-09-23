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
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { AppConfig } from "@/types/api";

interface GeneralSettingsProps {
    config: AppConfig;
    setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
    saving: boolean;
    /** 保存整个 config（由外层 SettingsDialog 统一校验并提交） */
    onSave: () => void;
}

export function GeneralSettings({ config, setConfig, saving, onSave }: GeneralSettingsProps) {
    const { t, language, setLanguage } = useLanguage();

    return (
        <div className="space-y-4 py-4">
            <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
                <div className="space-y-2">
                    <Label>{t.settings?.language || "Language"}</Label>
                    <Select
                        value={language}
                        onValueChange={(val: 'zh' | 'en') => setLanguage(val)}
                    >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="zh">中文 (Chinese)</SelectItem>
                            <SelectItem value="en">English</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2 pt-4 border-t">
                    <Label>{t.settings?.general?.timeoutLabel || "AI Analysis Timeout (Seconds)"}</Label>
                    <Input
                        type="number"
                        value={config.timeouts?.analyze ? config.timeouts.analyze / 1000 : ''}
                        onChange={(e) => {
                            const val = e.target.value === '' ? 0 : parseInt(e.target.value);
                            // Allow typing, validate later
                            setConfig(prev => ({
                                ...prev,
                                timeouts: {
                                    ...prev.timeouts,
                                    analyze: isNaN(val) ? 0 : val * 1000
                                }
                            }));
                        }}
                        onBlur={() => {
                            const currentVal = (config.timeouts?.analyze || 0) / 1000;
                            // Valid range 120-600, default 120
                            let safeVal = currentVal;
                            if (safeVal < 120) safeVal = 120;
                            if (safeVal > 600) safeVal = 600;

                            if (safeVal !== currentVal) {
                                setConfig(prev => ({
                                    ...prev,
                                    timeouts: {
                                        ...prev.timeouts,
                                        analyze: safeVal * 1000
                                    }
                                }));
                            }
                        }}
                        min={120}
                        max={600}
                    />
                    <p className="text-xs text-muted-foreground">
                        {t.settings?.general?.timeoutDesc || "Increase this value if you experience frequent timeouts during AI analysis."}
                    </p>
                </div>
            </div>
            <Button onClick={onSave} disabled={saving} className="w-full">
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t.settings?.save || "Save Settings"}
            </Button>
        </div>
    );
}
