import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Globe, Sparkles, ArrowRight, Loader2, Info, Trash2 } from 'lucide-react'
import { useProjectStore } from '../stores/projectStore'
import { useUiStore } from '../stores/uiStore'
import { CreateProjectWizard } from '../components/editor/CreateProjectWizard'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

const listPageText: Record<string, Record<string, string>> = {
  zh: {
    bannerTitle: '数据不会持久保存',
    bannerDesc: '当前部署使用临时存储，刷新或重启后数据将丢失。部署到本地可获得完整的历史记录与持久化功能。',
    closeBanner: '关闭提示',
    heroBadge: '叙事 AI 引擎',
    heroTitle: '你的世界',
    heroSubtitle: '锻造你的故事，塑造你的世界，开启你的传奇。',
    newWorld: '新建世界',
    loadingWorlds: '正在加载世界...',
    emptyTitle: '还没有世界',
    emptyDesc: '创建第一个世界，开始你的冒险',
    createWorld: '创建世界',
    open: '打开',
    delete: '删除',
    confirmDelete: '确认删除？',
    cancel: '取消',
  },
  en: {
    bannerTitle: 'Data is not persistent',
    bannerDesc: 'This deployment uses ephemeral storage. Data may be lost after refresh or restart. Deploy locally for full history and persistence.',
    closeBanner: 'Dismiss banner',
    heroBadge: 'Narrative AI Engine',
    heroTitle: 'Your Worlds',
    heroSubtitle: 'Forge your story. Shape your world. Begin your legend.',
    newWorld: 'New World',
    loadingWorlds: 'Loading worlds...',
    emptyTitle: 'No worlds yet',
    emptyDesc: 'Create your first world to begin your adventure',
    createWorld: 'Create World',
    open: 'Open',
    delete: 'Delete',
    confirmDelete: 'Confirm delete?',
    cancel: 'Cancel',
  },
}

export function ProjectListPage() {
  const { projects, loading, fetchProjects, deleteProject } = useProjectStore()
  const navigate = useNavigate()
  const [showWizard, setShowWizard] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const language = useUiStore((s) => s.language)
  const storagePersistent = useUiStore((s) => s.storagePersistent)
  const t = listPageText[language] ?? listPageText.en
  const locale = language === 'zh' ? 'zh-CN' : 'en-US'
  const [bannerDismissed, setBannerDismissed] = useState(
    () => localStorage.getItem('ai-gamestudio:ephemeral-banner-dismissed') === '1'
  )

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  const dismissBanner = () => {
    localStorage.setItem('ai-gamestudio:ephemeral-banner-dismissed', '1')
    setBannerDismissed(true)
  }

  return (
    <div className="flex-1 overflow-y-auto bg-background">
      {/* Ephemeral storage notice */}
      {storagePersistent === false && !bannerDismissed && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0 bg-amber-500/10 text-amber-500 border-amber-500/20">
          <Info className="h-4 w-4" />
          <AlertTitle className="flex items-center justify-between">
            {t.bannerTitle}
            <Button
              variant="ghost"
              size="sm"
              className="h-4 w-4 p-0 hover:bg-transparent text-amber-500/50 hover:text-amber-500"
              onClick={dismissBanner}
              aria-label={t.closeBanner}
            >
              ✕
            </Button>
          </AlertTitle>
          <AlertDescription className="text-amber-500/70 text-xs">
            {t.bannerDesc}
          </AlertDescription>
        </Alert>
      )}

      {/* Hero */}
      <div className="relative px-6 py-24 text-center overflow-hidden border-b bg-muted/30">
        <div className="absolute inset-0 bg-grid-white/10 bg-[size:20px_20px] [mask-image:linear-gradient(to_bottom,white,transparent)]" />
        <div className="relative z-10 max-w-2xl mx-auto space-y-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium mb-4">
            <Sparkles className="w-4 h-4" />
            {t.heroBadge}
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
            {t.heroTitle}
          </h1>
          <p className="text-xl text-muted-foreground">
            {t.heroSubtitle}
          </p>
          <div className="pt-4">
            <Button size="lg" onClick={() => setShowWizard(true)} className="gap-2">
              <Plus className="w-4 h-4" />
              {t.newWorld}
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-6 py-12">
        <CreateProjectWizard open={showWizard} onClose={() => setShowWizard(false)} />

        {loading && projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground gap-4">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <span className="text-sm font-medium">{t.loadingWorlds}</span>
          </div>
        ) : projects.length === 0 ? (
          <Card className="border-dashed flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-6">
              <Globe className="w-8 h-8 text-primary" />
            </div>
            <CardTitle className="mb-2">{t.emptyTitle}</CardTitle>
            <CardDescription className="mb-6">
              {t.emptyDesc}
            </CardDescription>
            <Button onClick={() => setShowWizard(true)} variant="outline" className="gap-2">
              <Plus className="w-4 h-4" />
              {t.createWorld}
            </Button>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map((project) => (
              <Card
                key={project.id}
                className="group cursor-pointer hover:border-primary/50 transition-all duration-300 hover:shadow-md overflow-hidden relative"
                onClick={() => confirmDeleteId !== project.id && navigate(`/projects/${project.id}`)}
              >
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4 text-primary">
                      <Globe className="w-5 h-5" />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(project.id) }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  <CardTitle className="line-clamp-1">{project.name}</CardTitle>
                  {project.description && (
                    <CardDescription className="line-clamp-2 mt-2 h-10">
                      {project.description}
                    </CardDescription>
                  )}
                </CardHeader>
                <CardFooter className="pt-0 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{new Date(project.created_at).toLocaleDateString(locale)}</span>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity text-primary font-medium translate-x-2 group-hover:translate-x-0 duration-300">
                    {t.open} <ArrowRight className="w-3 h-3" />
                  </div>
                </CardFooter>
                {confirmDeleteId === project.id && (
                  <div
                    className="absolute inset-0 bg-background/90 backdrop-blur-sm flex flex-col items-center justify-center gap-3 z-10"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="text-sm font-medium">{t.confirmDelete}</p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => setConfirmDeleteId(null)}>
                        {t.cancel}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => { deleteProject(project.id); setConfirmDeleteId(null) }}
                      >
                        {t.delete}
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
