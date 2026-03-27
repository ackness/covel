import { MapPin, ChevronDown } from 'lucide-react'
import type { Scene } from '../../types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'

interface Props {
  currentScene: Scene
  scenes: Scene[]
  onSceneSwitch: (sceneId: string) => void
}

export function SceneBar({ currentScene, scenes, onSceneSwitch }: Props) {
  const otherScenes = scenes.filter((s) => s.id !== currentScene.id)

  return (
    <div className="flex items-center gap-3 px-4 py-2 text-sm bg-background/80 backdrop-blur-md border-b shrink-0 z-10">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <MapPin className="w-4 h-4 text-emerald-500 shrink-0" />
        <span className="font-medium truncate text-emerald-600 dark:text-emerald-400">
          {currentScene.name}
        </span>
        {currentScene.description && (
          <span className="truncate hidden sm:inline text-xs text-muted-foreground">
            — {currentScene.description}
          </span>
        )}
      </div>

      {otherScenes.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1 px-2">
              切换场景 <ChevronDown className="w-3 h-3 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[200px]">
            {otherScenes.map((scene) => (
              <DropdownMenuItem
                key={scene.id}
                onClick={() => onSceneSwitch(scene.id)}
                className="text-xs py-1.5"
              >
                {scene.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
