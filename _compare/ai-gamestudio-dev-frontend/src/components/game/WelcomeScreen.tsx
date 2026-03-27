import { Play, Loader2, RefreshCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'

interface Props {
  onStart: () => void
  loading?: boolean
  error?: string | null
}

export function WelcomeScreen({ onStart, loading, error }: Props) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center relative overflow-hidden bg-background">
      {/* Ambient background glow */}
      <div className="absolute inset-0 pointer-events-none opacity-20">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-primary/20 blur-[100px]" />
      </div>

      <div className="relative text-center space-y-8 w-full max-w-sm px-6">
        {/* Icon */}
        <div className="flex justify-center">
          <div className="w-20 h-20 rounded-2xl flex items-center justify-center bg-primary/10 border border-primary/20 shadow-lg shadow-primary/5">
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none" className="text-primary drop-shadow-[0_0_8px_rgba(var(--primary),0.5)]">
              <path
                d="M18 4L22 13H32L24 19L27 29L18 23L9 29L12 19L4 13H14L18 4Z"
                fill="currentColor"
                opacity="0.9"
              />
            </svg>
          </div>
        </div>

        {/* Text */}
        <div className="space-y-3">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            准备开始冒险
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            世界已就绪，命运等待书写。<br />点击下方按钮，开始你的旅程。
          </p>
        </div>

        {/* Error */}
        {error && (
          <Alert variant="destructive" className="text-left">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* CTA Button */}
        <Button
          onClick={onStart}
          disabled={loading}
          size="lg"
          className="w-full text-base h-12 shadow-lg shadow-primary/20 hover:shadow-primary/30 transition-all hover:-translate-y-0.5"
        >
          {loading ? (
            <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> 正在初始化...</>
          ) : error ? (
            <><RefreshCcw className="w-5 h-5 mr-2" /> 重试</>
          ) : (
            <><Play className="w-5 h-5 mr-2 fill-current" /> 开始冒险</>
          )}
        </Button>
      </div>
    </div>
  )
}
