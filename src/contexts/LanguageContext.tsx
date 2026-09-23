"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { zh } from '@/lib/translations/zh';
import type { Dict, Language } from '@/lib/translations/types';

interface LanguageContextType {
    language: Language;
    setLanguage: (lang: Language) => void;
    t: Dict;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

// 英文词典按需加载并缓存（模块级单例，跨组件复用同一份 Promise）
let enDict: Dict | null = null;
let enPromise: Promise<Dict> | null = null;
function loadEn(): Promise<Dict> {
    if (enDict) return Promise.resolve(enDict);
    if (!enPromise) {
        enPromise = import('@/lib/translations/en').then((m) => {
            enDict = m.en;
            return m.en;
        });
    }
    return enPromise;
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
    const [language, setLanguageState] = useState<Language>('zh'); // Default to Chinese
    const [t, setT] = useState<Dict>(zh);

    useEffect(() => {
        const savedLang = localStorage.getItem('app-language') as Language | null;
        if (savedLang === 'en') {
            loadEn().then((dict) => {
                setT(dict);
                setLanguageState('en');
            });
        }
    }, []);

    const setLanguage = useCallback((lang: Language) => {
        localStorage.setItem('app-language', lang);
        if (lang === 'zh') {
            setT(zh);
            setLanguageState('zh');
        } else {
            // 词典加载完成后再切换，避免 t 短暂缺键
            loadEn().then((dict) => {
                setT(dict);
                setLanguageState('en');
            });
        }
    }, []);

    const value = useMemo(
        () => ({ language, setLanguage, t }),
        [language, setLanguage, t]
    );

    return (
        <LanguageContext.Provider value={value}>
            {children}
        </LanguageContext.Provider>
    );
}

export function useLanguage() {
    const context = useContext(LanguageContext);
    if (context === undefined) {
        throw new Error('useLanguage must be used within a LanguageProvider');
    }
    return context;
}
