import { useEffect, useMemo } from 'react'
import { Search, Skull, Gem, MapPin, BookOpen, User } from 'lucide-react'
import { useGameDataStore, type CodexEntry } from '../../stores/gameDataStore'
import { useProjectStore } from '../../stores/projectStore'
import { useUiStore } from '../../stores/uiStore'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

const CATEGORY_META: Record<
  string,
  { icon: React.ElementType; label: Record<string, string>; color: string }
> = {
  monster: { icon: Skull, label: { zh: '怪物', en: 'Monsters' }, color: 'text-red-400' },
  item: { icon: Gem, label: { zh: '物品', en: 'Items' }, color: 'text-blue-400' },
  location: { icon: MapPin, label: { zh: '地点', en: 'Locations' }, color: 'text-green-400' },
  lore: { icon: BookOpen, label: { zh: '传说', en: 'Lore' }, color: 'text-amber-400' },
  character: { icon: User, label: { zh: '角色', en: 'Characters' }, color: 'text-purple-400' },
}

const panelText: Record<string, Record<string, string>> = {
  zh: {
    empty: '暂无图鉴条目',
    search: '搜索图鉴或分类关键词…',
    newBadge: '新',
    newSection: '新发现',
    newHint: '已优先展示，查看后将归入分类。',
    loading: '加载中…',
    quickTags: '快速标签',
    clearFilter: '清除筛选',
  },
  en: {
    empty: 'No codex entries yet',
    search: 'Search codex or category keywords…',
    newBadge: 'NEW',
    newSection: 'New Discoveries',
    newHint: 'Prioritized first and moved into categories after viewing.',
    loading: 'Loading…',
    quickTags: 'Quick Tags',
    clearFilter: 'Clear',
  },
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  monster: ['monster', 'monsters', 'mob', 'enemy', '怪物', '敌人', '魔物'],
  item: ['item', 'items', 'loot', 'gear', '物品', '道具', '装备'],
  location: ['location', 'locations', 'place', 'area', '地点', '区域', '地名'],
  lore: ['lore', 'history', 'story', 'legend', '传说', '背景', '历史'],
  character: ['character', 'characters', 'npc', '人物', '角色', '人物志'],
}

function _matchesCategoryKeyword(entry: CodexEntry, query: string): boolean {
  const meta = CATEGORY_META[entry.category]
  const labels = meta ? [meta.label.zh, meta.label.en] : []
  const keywords = CATEGORY_KEYWORDS[entry.category] || []
  const tokens = [...labels, ...keywords].map((token) =>
    String(token || '').toLowerCase(),
  )
  return tokens.some((token) => token.includes(query) || query.includes(token))
}

function EntryCard({
  entry,
  language,
  onView,
}: {
  entry: CodexEntry
  language: string
  onView?: (entry: CodexEntry) => void
}) {
  const t = panelText[language] ?? panelText.en
  return (
    <div
      onClick={() => onView?.(entry)}
      className={`rounded-lg border p-2.5 ${
        entry._isNew ? 'border-amber-500/50 bg-amber-500/5 cursor-pointer' : 'border-border/50'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium truncate flex-1">{entry.title}</span>
        {entry._isNew && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-auto border-amber-500/50 text-amber-400">
            {t.newBadge}
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground mt-1 line-clamp-3">{entry.content}</p>
      {entry.tags && entry.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {entry.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0 h-auto">
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

export function CodexPanel() {
  const projectId = useProjectStore((s) => s.currentProject?.id)
  const language = useUiStore((s) => s.language)
  const {
    codexEntries: entries,
    codexLoading: loading,
    codexSearchQuery: searchQuery,
    setCodexSearchQuery: setSearchQuery,
    fetchCodexEntries: fetchEntries,
    markEntrySeen,
    markEntriesSeen,
    clearNewFlags,
  } = useGameDataStore()
  const t = panelText[language] ?? panelText.en

  useEffect(() => {
    if (projectId) fetchEntries(projectId)
  }, [projectId, fetchEntries])

  useEffect(() => {
    return () => clearNewFlags()
  }, [clearNewFlags])

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return entries
    const q = searchQuery.toLowerCase()
    return entries.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.content.toLowerCase().includes(q) ||
        e.tags?.some((tag) => tag.toLowerCase().includes(q)) ||
        _matchesCategoryKeyword(e, q),
    )
  }, [entries, searchQuery])

  const quickTags = useMemo(() => {
    const score = new Map<string, { count: number; latest: number }>()
    for (const entry of entries) {
      const latest = Number(entry._newAt || 0)
      if (!Array.isArray(entry.tags)) continue
      for (const rawTag of entry.tags) {
        const tag = String(rawTag || '').trim()
        if (!tag) continue
        const current = score.get(tag)
        if (current) {
          current.count += 1
          current.latest = Math.max(current.latest, latest)
        } else {
          score.set(tag, { count: 1, latest })
        }
      }
    }
    return Array.from(score.entries())
      .sort((a, b) => {
        if (b[1].count !== a[1].count) return b[1].count - a[1].count
        if (b[1].latest !== a[1].latest) return b[1].latest - a[1].latest
        return a[0].localeCompare(b[0], language === 'zh' ? 'zh-Hans-CN' : 'en-US')
      })
      .slice(0, 24)
      .map(([tag]) => tag)
  }, [entries, language])

  const hasSearchQuery = searchQuery.trim().length > 0

  const prioritizedNewEntries = useMemo(() => {
    if (hasSearchQuery) return []
    return filtered
      .filter((entry) => entry._isNew)
      .sort((a, b) => (b._newAt || 0) - (a._newAt || 0))
  }, [filtered, hasSearchQuery])

  const entriesForGroupedView = useMemo(() => {
    if (hasSearchQuery || prioritizedNewEntries.length === 0) return filtered
    const newIds = new Set(prioritizedNewEntries.map((entry) => entry.entry_id))
    return filtered.filter((entry) => !newIds.has(entry.entry_id))
  }, [filtered, hasSearchQuery, prioritizedNewEntries])

  const newSummaryByCategory = useMemo(() => {
    const grouped = new Map<string, CodexEntry[]>()
    for (const entry of prioritizedNewEntries) {
      const list = grouped.get(entry.category) || []
      list.push(entry)
      grouped.set(entry.category, list)
    }
    return Array.from(grouped.entries()).sort((a, b) => {
      const labelA = CATEGORY_META[a[0]]?.label[language] ?? a[0]
      const labelB = CATEGORY_META[b[0]]?.label[language] ?? b[0]
      return labelA.localeCompare(labelB, language === 'zh' ? 'zh-Hans-CN' : 'en-US')
    })
  }, [prioritizedNewEntries, language])

  const grouped = useMemo(() => {
    const map = new Map<string, CodexEntry[]>()
    for (const entry of entriesForGroupedView) {
      const list = map.get(entry.category) || []
      list.push(entry)
      map.set(entry.category, list)
    }
    return map
  }, [entriesForGroupedView])

  if (loading) {
    return <p className="text-muted-foreground text-sm text-center py-4">{t.loading}</p>
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t.search}
          className="pl-8 h-8 text-sm"
        />
      </div>

      {quickTags.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">{t.quickTags}</span>
            {hasSearchQuery && (
              <button
                className="text-[11px] text-muted-foreground hover:text-foreground underline"
                onClick={() => setSearchQuery('')}
              >
                {t.clearFilter}
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {quickTags.map((tag) => {
              const active = searchQuery.trim().toLowerCase() === tag.toLowerCase()
              return (
                <button
                  key={tag}
                  onClick={() => setSearchQuery(active ? '' : tag)}
                  className={`text-[11px] rounded-full px-2 py-0.5 border transition-colors ${
                    active
                      ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
                      : 'border-border/60 bg-background hover:border-amber-500/40 hover:text-amber-200'
                  }`}
                >
                  #{tag}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {filtered.length === 0 && (
        <p className="text-muted-foreground text-sm text-center py-4">{t.empty}</p>
      )}

      {prioritizedNewEntries.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-amber-400">
              ✨ {t.newSection}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {t.newHint}
            </span>
          </div>
          <div className="space-y-1 text-xs leading-relaxed">
            {newSummaryByCategory.map(([category, items]) => {
              const meta = CATEGORY_META[category]
              const label = meta ? (meta.label[language] ?? meta.label.en) : category
              return (
                <div key={category} className="text-muted-foreground">
                  <span
                    className={`font-medium mr-1 ${meta?.color || 'text-amber-300'}`}
                    onClick={() => markEntriesSeen(items.map((entry) => entry.entry_id))}
                  >
                    {label}:
                  </span>
                  {items.map((entry, idx) => (
                    <span key={entry.entry_id}>
                      <button
                        className="text-foreground/90 hover:text-amber-200 underline-offset-2 hover:underline"
                        onClick={() => markEntrySeen(entry.entry_id)}
                      >
                        {entry.title}
                      </button>
                      {idx < items.length - 1 ? (
                        <span className="text-muted-foreground/70">, </span>
                      ) : null}
                    </span>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {Array.from(grouped.entries()).map(([category, items]) => {
        const meta = CATEGORY_META[category]
        if (!meta) return null
        const Icon = meta.icon
        const label = meta.label[language] ?? meta.label.en
        return (
          <div key={category}>
            <div className={`flex items-center gap-1.5 mb-2 ${meta.color}`}>
              <Icon className="w-3.5 h-3.5" />
              <h4 className="text-xs font-medium uppercase">{label}</h4>
              <span className="text-[10px] text-muted-foreground">({items.length})</span>
            </div>
            <div className="space-y-2">
              {items.map((entry) => (
                <EntryCard
                  key={entry.entry_id}
                  entry={entry}
                  language={language}
                  onView={entry._isNew ? () => markEntrySeen(entry.entry_id) : undefined}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
