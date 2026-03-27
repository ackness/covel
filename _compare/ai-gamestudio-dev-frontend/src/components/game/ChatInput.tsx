import { useState, useRef, useEffect } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  onSend: (message: string) => void
  disabled: boolean
}

export function ChatInput({ onSend, disabled }: Props) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
    }
  }, [value])

  const handleSubmit = () => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setValue('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="p-3 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-t z-10 shrink-0">
      <div className="relative flex items-end w-full max-w-4xl mx-auto rounded-xl bg-muted/40 border focus-within:ring-1 focus-within:ring-primary/30 focus-within:border-primary/50 transition-all shadow-sm">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
          className="flex-1 max-h-32 min-h-[44px] w-full resize-none bg-transparent px-4 py-3 text-sm focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={disabled ? 'Waiting for response...' : 'What do you do?'}
        />
        <div className="flex items-center gap-2 p-2 shrink-0">
          <Button
            size="icon"
            className="h-8 w-8 rounded-lg"
            onClick={handleSubmit}
            disabled={disabled || !value.trim()}
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-center gap-4 mt-2 text-[10px] text-muted-foreground/60 max-w-4xl mx-auto">
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded-md bg-muted/50 border text-[9px] font-sans">Enter</kbd> to send
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded-md bg-muted/50 border text-[9px] font-sans">Shift</kbd> + <kbd className="px-1.5 py-0.5 rounded-md bg-muted/50 border text-[9px] font-sans">Enter</kbd> for new line
        </span>
      </div>
    </div>
  )
}
