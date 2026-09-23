"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Info, ExternalLink, Github, ScrollText, MessageSquareText } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export function AboutSettings() {
    const { t } = useLanguage();
    const [version, setVersion] = useState<string>("");

    // 获取版本号
    useEffect(() => {
        fetch("/api/version")
            .then((res) => res.json())
            .then((data) => setVersion(data.version))
            .catch(() => {});
    }, []);

    return (
        <div className="space-y-4 py-4">
            <div className="flex flex-col items-center justify-center space-y-6 py-8 text-center bg-muted/30 rounded-lg border">
                <div className="space-y-2">
                    <h3 className="text-2xl font-bold">{t.app?.title || "Smart Error Notebook"}</h3>
                    <p className="text-muted-foreground">
                        {t.settings?.about?.desc || "AI-powered learning assistant"}
                    </p>
                </div>

                <div className="flex items-center space-x-2 text-sm text-muted-foreground border px-4 py-2 rounded-full bg-background">
                    <Info className="h-4 w-4" />
                    <span>{t.settings?.about?.version || "Version"}: v{version || "unknown"}</span>
                </div>

                <div className="flex flex-col sm:flex-row flex-wrap justify-center gap-4 w-full sm:w-auto px-4 sm:px-0">
                    <Button variant="outline" asChild className="gap-2 w-full sm:w-auto">
                        <a href="https://github.com/wttwins/wrong-notebook" target="_blank" rel="noopener noreferrer">
                            <Github className="h-4 w-4" />
                            {t.settings?.about?.github || "GitHub Repository"}
                            <ExternalLink className="h-3 w-3 ml-1 opacity-50" />
                        </a>
                    </Button>

                    <Button variant="outline" asChild className="gap-2 w-full sm:w-auto">
                        <a href="https://github.com/wttwins/wrong-notebook/releases" target="_blank" rel="noopener noreferrer">
                            <ScrollText className="h-4 w-4" />
                            {t.settings?.about?.releaseNotes || "Release Notes"}
                            <ExternalLink className="h-3 w-3 ml-1 opacity-50" />
                        </a>
                    </Button>

                    <Button variant="outline" asChild className="gap-2 w-full sm:w-auto">
                        <a href="https://github.com/wttwins/wrong-notebook/issues" target="_blank" rel="noopener noreferrer">
                            <MessageSquareText className="h-4 w-4" />
                            {t.settings?.about?.feedback || "Feedback"}
                            <ExternalLink className="h-3 w-3 ml-1 opacity-50" />
                        </a>
                    </Button>
                </div>

                <p className="text-xs text-muted-foreground mt-8">
                    {t.settings?.about?.copyright || "© 2025 Wttwins. All rights reserved."}
                </p>
            </div>
        </div>
    );
}
