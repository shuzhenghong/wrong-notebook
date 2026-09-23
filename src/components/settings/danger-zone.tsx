"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Trash2, Loader2, AlertTriangle, RefreshCw, Download, Upload, CheckCircle2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useSession } from "next-auth/react";
import { apiClient } from "@/lib/api-client";
import { frontendLogger } from "@/lib/frontend-logger";

interface DangerZoneSettingsProps {
    /** 完成清理类操作后由外层关闭对话框 */
    onClose: () => void;
}

export function DangerZoneSettings({ onClose }: DangerZoneSettingsProps) {
    const { t } = useLanguage();
    const { data: session } = useSession();
    const isAdmin = (session?.user as any)?.role === 'admin';

    const [clearingPractice, setClearingPractice] = useState(false);
    const [clearingError, setClearingError] = useState(false);
    const [systemResetting, setSystemResetting] = useState(false);
    const [migratingTags, setMigratingTags] = useState(false);

    // Import/Export state
    const [exporting, setExporting] = useState(false);
    const [importing, setImporting] = useState(false);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [selectedFileName, setSelectedFileName] = useState<string>("");

    const handleClearData = async () => {
        if (!confirm(t.settings?.clearDataConfirm || "Are you sure?")) {
            return;
        }

        setClearingPractice(true);
        try {
            await apiClient.delete("/api/stats/practice/clear");
            alert(t.settings?.clearSuccess || "Success");
            onClose();
            window.location.reload();
        } catch (error) {
            frontendLogger.error('[DangerZone]', 'Failed to clear practice data', { error: error instanceof Error ? error.message : String(error) });
            alert(t.settings?.clearError || "Failed");
        } finally {
            setClearingPractice(false);
        }
    };

    const handleClearErrorData = async () => {
        if (!confirm(t.settings?.clearErrorDataConfirm || "Are you sure?")) {
            return;
        }

        setClearingError(true);
        try {
            await apiClient.delete("/api/error-items/clear");
            alert(t.settings?.clearSuccess || "Success");
            onClose();
            window.location.reload();
        } catch (error) {
            frontendLogger.error('[DangerZone]', 'Failed to clear error data', { error: error instanceof Error ? error.message : String(error) });
            alert(t.settings?.clearError || "Failed");
        } finally {
            setClearingError(false);
        }
    };

    const handleSystemReset = async () => {
        // Double confirm
        if (!confirm(t.settings?.systemResetConfirm || "WARNING: Deleting ALL data. Undoing is impossible. Are you sure?")) {
            return;
        }

        // Optional triple confirm?
        const userInput = prompt(t.settings?.systemResetPrompt || "Type 'RESET' to confirm system initialization:", "");
        if (userInput !== 'RESET') {
            if (userInput !== null) alert(t.common?.error || "Confirmation failed");
            return;
        }

        setSystemResetting(true);
        try {
            const result = await apiClient.post<{ backup?: string | null }>("/api/admin/system-reset", {
                confirm: "DELETE ALL DATA",
            });
            alert(t.settings?.clearSuccess || "Success - System Reset Complete");
            if (result?.backup) {
                console.info('[DangerZone] Pre-reset backup saved as', result.backup);
            }
            onClose();
            window.location.reload();
        } catch (error) {
            frontendLogger.error('[DangerZone]', 'System reset failed', { error: error instanceof Error ? error.message : String(error) });
            alert(t.settings?.clearError || "Failed to reset system");
        } finally {
            setSystemResetting(false);
        }
    };

    const handleExportData = async () => {
        setExporting(true);
        try {
            const res = await fetch('/api/export');
            if (!res.ok) {
                throw new Error('Export failed');
            }
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            // Get filename from Content-Disposition header or use default
            const disposition = res.headers.get('Content-Disposition');
            const filenameMatch = disposition?.match(/filename="(.+)"/);
            a.download = filenameMatch ? filenameMatch[1] : 'wrong-notebook-export.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            alert(t.settings?.exportSuccess || "Export successful");
        } catch (error) {
            frontendLogger.error('[DangerZone]', 'Export failed', { error: error instanceof Error ? error.message : String(error) });
            alert(t.settings?.exportFailed || "Export failed");
        } finally {
            setExporting(false);
        }
    };

    const handleExportAllData = async () => {
        if (!confirm(t.settings?.exportAllConfirm || "Export all users' data? This may take a while.")) {
            return;
        }
        setExporting(true);
        try {
            const res = await fetch('/api/export?all=true');
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.message || 'Export failed');
            }
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const disposition = res.headers.get('Content-Disposition');
            const filenameMatch = disposition?.match(/filename="(.+)"/);
            a.download = filenameMatch ? filenameMatch[1] : 'wrong-notebook-export-all.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            alert(t.settings?.exportSuccess || "Export successful");
        } catch (error) {
            frontendLogger.error('[DangerZone]', 'Export all failed', { error: error instanceof Error ? error.message : String(error) });
            alert(t.settings?.exportFailed || "Export failed");
        } finally {
            setExporting(false);
        }
    };

    const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setSelectedFile(file);
            setSelectedFileName(file.name);
        }
    };

    const handleImportData = async () => {
        if (!selectedFile) return;

        if (!confirm(t.settings?.importConfirm || "Are you sure you want to import?")) {
            return;
        }

        setImporting(true);
        try {
            const text = await selectedFile.text();
            const data = JSON.parse(text);

            const response = await apiClient.post('/api/import', data);
            const stats = (response as any).stats;

            alert(
                (t.settings?.importResultDesc || "Imported {subjects} notebooks, {tags} tags, {items} error items, {schedules} review schedules, {records} practice records.")
                    .replace('{subjects}', String(stats.subjectsCreated))
                    .replace('{tags}', String(stats.tagsCreated))
                    .replace('{items}', String(stats.errorItemsCreated))
                    .replace('{schedules}', String(stats.reviewSchedulesCreated))
                    .replace('{records}', String(stats.practiceRecordsCreated))
            );

            setSelectedFile(null);
            setSelectedFileName("");
            window.location.reload();
        } catch (error) {
            frontendLogger.error('[DangerZone]', 'Import failed', { error: error instanceof Error ? error.message : String(error) });
            alert(t.settings?.importFailed || "Import failed");
        } finally {
            setImporting(false);
        }
    };

    const handleImportAllData = async () => {
        if (!selectedFile) return;

        if (!confirm(t.settings?.importAllConfirm || "Import all users' data? This will restore data for all users from the export file.")) {
            return;
        }

        setImporting(true);
        try {
            const text = await selectedFile.text();
            const data = JSON.parse(text);
            const res = await fetch("/api/import?all=true", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data),
            });
            const result = await res.json();
            if (result.success) {
                const s = result.stats;
                alert(
                    (t.settings?.importResultDesc || "Imported {subjects} notebooks, {tags} tags, {items} error items, {schedules} review schedules, {records} practice records.")
                        .replace('{subjects}', String(s.subjectsCreated))
                        .replace('{tags}', String(s.tagsCreated))
                        .replace('{items}', String(s.errorItemsCreated))
                        .replace('{schedules}', String(s.reviewSchedulesCreated))
                        .replace('{records}', String(s.practiceRecordsCreated))
                );

                setSelectedFile(null);
                setSelectedFileName("");
                window.location.reload();
            } else {
                throw new Error(result.message || "Import failed");
            }
        } catch (error) {
            frontendLogger.error('[DangerZone]', 'Import all failed', { error: error instanceof Error ? error.message : String(error) });
            alert(t.settings?.importFailed || "Import failed");
        } finally {
            setImporting(false);
        }
    };

    const handleMigrateTags = async () => {
        if (!confirm(t.settings?.migrateTagsConfirm || "This will reset system tags. Confirm?")) {
            return;
        }

        setMigratingTags(true);
        try {
            const res = await apiClient.post("/api/admin/migrate-tags", {});
            alert(`${t.settings?.clearSuccess || "Success"}: ${(res as any).count || 0} tags migrated.`);
            // No reload needed necessarily, but good to refresh if user is viewing tags.
        } catch (error) {
            frontendLogger.error('[DangerZone]', 'Tag migration failed', { error: error instanceof Error ? error.message : String(error) });
            alert(t.settings?.clearError || "Failed to migrate tags");
        } finally {
            setMigratingTags(false);
        }
    };

    return (
        <div className="space-y-4 py-4">
            <div className="space-y-3">
                {/* Data Management Section - Available to all users */}
                <div className="p-4 border border-blue-200 rounded-lg bg-blue-50">
                    <h4 className="text-sm font-bold text-blue-900 mb-3">
                        {t.settings?.dataManagement || "Data Management"}
                    </h4>

                    {/* Export */}
                    <div className="mb-4">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-sm text-blue-800 font-medium">
                                {t.settings?.exportData || "Export Data"}
                            </span>
                            <div className="flex items-center gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleExportData}
                                    disabled={exporting}
                                    className="bg-blue-100 hover:bg-blue-200 text-blue-900 border-blue-300"
                                >
                                    {exporting ? (
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    ) : (
                                        <Download className="mr-2 h-4 w-4" />
                                    )}
                                    {t.settings?.exportData || "Export"}
                                </Button>
                                {isAdmin && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleExportAllData}
                                        disabled={exporting}
                                        className="bg-orange-100 hover:bg-orange-200 text-orange-900 border-orange-300"
                                    >
                                        {exporting ? (
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        ) : (
                                            <Download className="mr-2 h-4 w-4" />
                                        )}
                                        {t.settings?.exportAllData || "Export All"}
                                    </Button>
                                )}
                            </div>
                        </div>
                        <p className="text-xs text-blue-700">
                            {t.settings?.exportDataDesc || "Export all data as JSON file."}
                        </p>
                    </div>

                    {/* Import */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-sm text-blue-800 font-medium">
                                {t.settings?.importData || "Import Data"}
                            </span>
                            <div className="flex items-center gap-2">
                                <input
                                    type="file"
                                    accept=".json"
                                    onChange={handleImportFileChange}
                                    className="hidden"
                                    id="import-file-input"
                                    disabled={importing}
                                />
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => document.getElementById('import-file-input')?.click()}
                                    disabled={importing}
                                    className="bg-blue-100 hover:bg-blue-200 text-blue-900 border-blue-300"
                                >
                                    {importing ? (
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    ) : (
                                        <Upload className="mr-2 h-4 w-4" />
                                    )}
                                    {selectedFileName || t.settings?.selectFile || "Select File"}
                                </Button>
                                {selectedFile && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleImportData}
                                        disabled={importing}
                                        className="bg-green-100 hover:bg-green-200 text-green-900 border-green-300"
                                    >
                                        {importing ? (
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        ) : (
                                            <CheckCircle2 className="mr-2 h-4 w-4" />
                                        )}
                                        {t.settings?.importData || "Import"}
                                    </Button>
                                )}
                                {selectedFile && isAdmin && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleImportAllData}
                                        disabled={importing}
                                        className="bg-orange-100 hover:bg-orange-200 text-orange-900 border-orange-300"
                                    >
                                        {importing ? (
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        ) : (
                                            <CheckCircle2 className="mr-2 h-4 w-4" />
                                        )}
                                        {t.settings?.importAllData || "Import All"}
                                    </Button>
                                )}
                            </div>
                        </div>
                        <p className="text-xs text-blue-700">
                            {t.settings?.importDataDesc || "Import data from JSON file. Existing data will be skipped."}
                        </p>
                    </div>
                </div>

                {/* Migrate Tags (Admin Only) */}
                {isAdmin && (
                    <div className="p-4 border border-blue-200 rounded-lg bg-blue-50">
                        <div className="flex items-center justify-between">
                            <div className="flex flex-col">
                                <span className="text-sm text-blue-900 font-bold flex items-center gap-2">
                                    <RefreshCw className="h-4 w-4" />
                                    {t.settings?.migrateTags || "Migrate Tags"}
                                </span>
                            </div>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleMigrateTags}
                                disabled={migratingTags}
                                className="bg-blue-100 hover:bg-blue-200 text-blue-900 border-blue-300"
                            >
                                {migratingTags ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <RefreshCw className="h-4 w-4" />
                                )}
                            </Button>
                        </div>
                        <p className="text-xs text-blue-800 mt-2 font-medium">
                            {t.settings?.migrateTagsDesc || 'Re-populates standard tags from file'}
                        </p>
                    </div>
                )}

                {/* Clear Practice Data */}
                <div className="p-4 border border-red-200 rounded-lg bg-red-50">
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-red-700 font-medium">
                            {t.settings?.clearData || "Clear Practice Data"}
                        </span>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={handleClearData}
                            disabled={clearingPractice}
                        >
                            {clearingPractice ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Trash2 className="h-4 w-4" />
                            )}
                        </Button>
                    </div>
                    <p className="text-xs text-red-600 mt-2">
                        {t.settings?.clearDataDesc || 'This will permanently delete all practice history. Irreversible.'}
                    </p>
                </div>

                {/* Clear Error Data */}
                <div className="p-4 border border-red-200 rounded-lg bg-red-50">
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-red-700 font-medium">
                            {t.settings?.clearErrorData || "Clear Error Data"}
                        </span>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={handleClearErrorData}
                            disabled={clearingError}
                        >
                            {clearingError ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Trash2 className="h-4 w-4" />
                            )}
                        </Button>
                    </div>
                    <p className="text-xs text-red-600 mt-2">
                        {t.settings?.clearErrorDataDesc || 'This will permanently delete all error items. Irreversible.'}
                    </p>
                </div>

                {/* System Reset (Admin Only) */}
                {isAdmin && (
                    <div className="p-4 border border-red-600/50 rounded-lg bg-red-100/50">
                        <div className="flex items-center justify-between">
                            <div className="flex flex-col">
                                <span className="text-sm text-red-900 font-bold flex items-center gap-2">
                                    <AlertTriangle className="h-4 w-4" />
                                    {t.settings?.systemReset || "System Initialization"}
                                </span>
                            </div>
                            <Button
                                variant="destructive"
                                size="sm"
                                onClick={handleSystemReset}
                                disabled={systemResetting}
                                className="bg-red-700 hover:bg-red-800"
                            >
                                {systemResetting ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Trash2 className="h-4 w-4" />
                                )}
                            </Button>
                        </div>
                        <p className="text-xs text-red-800 mt-2 font-medium">
                            {t.settings?.systemResetDesc || 'Resets the system to factory state. Deletes ALL data.'}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
