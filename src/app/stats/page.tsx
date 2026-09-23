"use client";

import { useLanguage } from "@/contexts/LanguageContext";
import dynamic from "next/dynamic";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { BarChart3, TrendingUp, Activity, House } from "lucide-react";
import Link from "next/link";

// recharts 体积较大（~150KB gzip 前），且只有切到对应 tab 才可见，
// 动态加载把它从 /stats 首屏 bundle 中移除。
const ChartSkeleton = () => (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading charts">
        <div className="h-6 w-48 bg-muted rounded" />
        <div className="h-72 bg-muted rounded" />
        <div className="grid grid-cols-2 gap-4">
            <div className="h-24 bg-muted rounded" />
            <div className="h-24 bg-muted rounded" />
        </div>
    </div>
);

const WrongAnswerStats = dynamic(
    () => import("@/components/wrong-answer-stats").then((m) => m.WrongAnswerStats),
    { loading: ChartSkeleton, ssr: false }
);
const PracticeStats = dynamic(
    () => import("@/components/practice-stats").then((m) => m.PracticeStats),
    { loading: ChartSkeleton, ssr: false }
);

export default function StatsPage() {
    const { t, language } = useLanguage();

    return (
        <div className="container mx-auto px-4 py-8 max-w-6xl">
            <div className="flex items-center gap-4 mb-6">
                <BackButton fallbackUrl="/" />
                <div>
                    <h1 className="text-3xl font-bold flex items-center gap-2">
                        <BarChart3 className="h-8 w-8" />
                        {t.stats?.headerTitle || "Statistics Center"}
                    </h1>
                    <p className="text-muted-foreground mt-1">
                        {t.stats?.headerDesc || "View your learning progress and data analysis"}
                    </p>
                </div>
                <div className="ml-auto flex items-center">
                    <Link href="/">
                        <Button variant="ghost" size="icon">
                            <House className="h-5 w-5" />
                        </Button>
                    </Link>
                </div>
            </div>

            <Tabs defaultValue="wrong" className="w-full">
                <TabsList className="grid w-full grid-cols-2 mb-6">
                    <TabsTrigger value="wrong" className="flex items-center gap-2">
                        <Activity className="h-4 w-4" />
                        {t.wrongAnswerStats?.title || "Wrong Answer Stats"}
                    </TabsTrigger>
                    <TabsTrigger value="practice" className="flex items-center gap-2">
                        <TrendingUp className="h-4 w-4" />
                        {t.stats?.title || "Practice Stats"}
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="wrong" className="space-y-4">
                    <WrongAnswerStats />
                </TabsContent>
                <TabsContent value="practice" className="space-y-4">
                    <PracticeStats />
                </TabsContent>
            </Tabs>
        </div>
    );
}
