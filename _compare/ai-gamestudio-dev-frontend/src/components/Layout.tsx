import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useUiStore } from '../stores/uiStore'

const SUPPORTED_LANGS = [
  { code: 'en', label: 'EN' },
  { code: 'zh', label: '中文' },
] as const

const layoutText: Record<string, Record<string, string>> = {
  zh: { brand: 'AI GameStudio', projects: '项目', alpha: '测试版' },
  en: { brand: 'AI GameStudio', projects: 'Projects', alpha: 'ALPHA' },
}

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const isEditor = location.pathname.startsWith('/projects/')
  const { checkStoragePersistence, language, setLanguage } = useUiStore()
  const t = layoutText[language] ?? layoutText.en

  useEffect(() => {
    checkStoragePersistence()
  }, [checkStoragePersistence])

  return (
    <div className="flex flex-col h-screen bg-background">
      <header className="h-12 shrink-0 px-5 flex items-center justify-between border-b bg-muted/20 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex items-center gap-5">
          <Link to="/" className="flex items-center gap-2.5 no-underline group">
            {/* Arcane sigil icon */}
            <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-primary/10 border border-primary/30 shadow-[0_0_12px_rgba(16,185,129,0.15)]">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 2L10.5 6.5H14L10.8 9.2L12 14L8 11.5L4 14L5.2 9.2L2 6.5H5.5L8 2Z"
                  fill="url(#star-grad)" stroke="rgba(16,185,129,0.6)" strokeWidth="0.5" />
                <defs>
                  <linearGradient id="star-grad" x1="2" y1="2" x2="14" y2="14">
                    <stop offset="0%" stopColor="#10b981" stopOpacity="0.9" />
                    <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.9" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <span className="font-cinzel text-base font-medium tracking-wide bg-gradient-to-r from-emerald-400 via-emerald-500 to-cyan-500 bg-clip-text text-transparent">
              {t.brand}
            </span>
          </Link>

          {isEditor && (
            <Link to="/" className="flex items-center gap-1.5 no-underline group text-muted-foreground/70 hover:text-muted-foreground transition-colors">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M8 2L4 6l4 4" />
              </svg>
              <span className="text-xs">{t.projects}</span>
            </Link>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center bg-muted rounded-md p-1 border">
            {SUPPORTED_LANGS.map((lang) => (
              <button
                key={lang.code}
                type="button"
                onClick={() => setLanguage(lang.code)}
                className={`text-xs px-2.5 py-1 rounded-sm font-medium transition-all ${
                  language === lang.code
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                aria-label={lang.label}
              >
                {lang.label}
              </button>
            ))}
          </div>
          <div className="text-[10px] font-mono tracking-widest uppercase px-2 py-0.5 rounded border border-violet-500/15 bg-violet-500/8 text-violet-400/60">
            {t.alpha}
          </div>
        </div>
      </header>
      <main className="flex-1 flex flex-col overflow-hidden min-h-0">
        {children}
      </main>
    </div>
  )
}
