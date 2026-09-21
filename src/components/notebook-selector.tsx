"use client";

import { useEffect, useState } from "react";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { BookOpen } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { Notebook } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";

interface NotebookSelectorProps {
    value?: string;
    onChange: (value: string) => void;
    className?: string;
}

export function NotebookSelector({ value, onChange, className }: NotebookSelectorProps) {
    const [notebooks, setNotebooks] = useState<Notebook[]>([]);
    const [loading, setLoading] = useState(true);
    const { t } = useLanguage();

    useEffect(() => {
        const fetchNotebooks = async () => {
            try {
                const data = await apiClient.get<Notebook[]>("/api/notebooks");
                setNotebooks(data);
                // 如果传入的 value 不在当前用户 notebook 列表里，通知父组件清空
                if (value && !data.some(n => n.id === value)) {
                    console.warn('[NotebookSelector]', 'value does not belong to current user, clearing');
                    onChange('');
                }
            } catch (error) {
                console.error("Failed to fetch notebooks:", error);
            } finally {
                setLoading(false);
            }
        };

        fetchNotebooks();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 只有 value 确实在当前用户 notebook 列表里才使用，否则置 undefined 显示 placeholder
    const effectiveValue = value && notebooks.some(n => n.id === value) ? value : undefined;

    return (
        <Select value={effectiveValue} onValueChange={onChange}>
            <SelectTrigger className={className}>
                <div className="flex items-center gap-2">
                    <BookOpen className="h-4 w-4 text-muted-foreground" />
                    <SelectValue placeholder={t.notebooks?.selector?.placeholder || "Select Notebook"} />
                </div>
            </SelectTrigger>
            <SelectContent>
                {notebooks.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground text-center">
                        {t.notebooks?.selector?.empty || "No notebooks available"}
                    </div>
                ) : (
                    notebooks.map((notebook) => (
                        <SelectItem key={notebook.id} value={notebook.id}>
                            {notebook.name}
                        </SelectItem>
                    ))
                )}
            </SelectContent>
        </Select>
    );
}
