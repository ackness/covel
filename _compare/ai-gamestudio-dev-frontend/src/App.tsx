import { Component, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { ProjectListPage } from './pages/ProjectListPage'
import { ProjectEditorPage } from './pages/ProjectEditorPage'
import { DebugTablesPage } from './pages/DebugTablesPage'
import { TooltipProvider } from '@/components/ui/tooltip'

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-8">
          <div className="bg-card border border-red-700/50 rounded-xl p-6 max-w-lg w-full space-y-4">
            <h2 className="text-red-400 text-lg font-medium">Something went wrong</h2>
            <pre className="text-xs text-muted-foreground bg-muted rounded p-3 overflow-auto max-h-40">
              {this.state.error?.message}
            </pre>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="text-sm px-4 py-2 bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function App() {
  return (
    <ErrorBoundary>
      <TooltipProvider>
        <BrowserRouter>
          <Layout>
            <Routes>
              <Route path="/" element={<ProjectListPage />} />
              <Route path="/projects/:id" element={<ProjectEditorPage />} />
              <Route path="/debug/session/:sessionId" element={<DebugTablesPage />} />
            </Routes>
          </Layout>
        </BrowserRouter>
      </TooltipProvider>
    </ErrorBoundary>
  )
}

export default App
