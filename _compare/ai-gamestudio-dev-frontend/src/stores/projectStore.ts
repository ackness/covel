import { create } from 'zustand'
import type { Project } from '../types'
import * as api from '../services/api'
import { StorageFactory } from '../services/settingsStorage'
import {
  idbGetProjects,
  idbGetProject,
  idbPutProject,
  idbDeleteProject,
} from '../services/localDb'
import { validateIdbRows, validateIdbRecord, toIdbRecord } from '../utils/idbValidation'

interface ProjectStore {
  projects: Project[]
  currentProject: Project | null
  loading: boolean
  fetchProjects: () => Promise<void>
  createProject: (data: { name: string; description?: string; world_doc?: string }) => Promise<Project>
  selectProject: (id: string) => Promise<void>
  updateWorldDoc: (worldDoc: string, projectId?: string) => Promise<void>
  updateProject: (data: Partial<Project>, projectId?: string) => Promise<void>
  setCurrentProject: (project: Project | null) => void
  deleteProject: (id: string) => Promise<void>
  /** Ensure the given project exists in the backend SQLite with latest data (re-syncs after cold start). */
  syncProjectToBackend: (project: Project) => Promise<void>
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  currentProject: null,
  loading: false,

  fetchProjects: async () => {
    set({ loading: true })
    try {
      const persistent = await StorageFactory.isStoragePersistent()
      if (!persistent) {
        const rows = await idbGetProjects()
        set({ projects: validateIdbRows<Project>(rows, ['id', 'name']), loading: false })
      } else {
        const projects = await api.getProjects()
        set({ projects, loading: false })
      }
    } catch {
      set({ loading: false })
    }
  },

  createProject: async (data) => {
    const persistent = await StorageFactory.isStoragePersistent()
    const project = await api.createProject(data)
    if (!persistent) {
      await idbPutProject(toIdbRecord(project))
    }
    set((state) => ({ projects: [...state.projects, project] }))
    return project
  },

  selectProject: async (id) => {
    set({ loading: true })
    try {
      const persistent = await StorageFactory.isStoragePersistent()
      if (!persistent) {
        const row = await idbGetProject(id)
        if (row) {
          const validated = validateIdbRecord<Project>(row, ['id', 'name'])
          if (validated) {
            set({ currentProject: validated, loading: false })
            return
          }
          return
        }
      }
      const project = await api.getProject(id)
      set({ currentProject: project, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  updateWorldDoc: async (worldDoc, projectId) => {
    const currentProject = get().currentProject
    const targetProjectId = projectId ?? currentProject?.id
    if (!targetProjectId) return

    const persistent = await StorageFactory.isStoragePersistent()

    if (!persistent) {
      // Local-first: merge into current state and persist to IndexedDB immediately
      const base = (currentProject?.id === targetProjectId ? currentProject : null)
        ?? validateIdbRecord<Project>(await idbGetProject(targetProjectId), ['id', 'name'])
      if (!base) return
      const updated: Project = { ...base, world_doc: worldDoc, updated_at: new Date().toISOString() }
      await idbPutProject(toIdbRecord(updated))
      set((state) => (state.currentProject?.id === targetProjectId ? { currentProject: updated } : {}))
      // Best-effort backend sync
      try { await get().syncProjectToBackend(updated) } catch (err) { console.warn('updateWorldDoc: backend sync failed:', err) }
    } else {
      const updated = await api.updateProject(targetProjectId, { world_doc: worldDoc })
      set((state) => (state.currentProject?.id === targetProjectId ? { currentProject: updated } : {}))
    }
  },

  updateProject: async (data, projectId) => {
    const currentProject = get().currentProject
    const targetProjectId = projectId ?? currentProject?.id
    if (!targetProjectId) return

    const persistent = await StorageFactory.isStoragePersistent()

    if (!persistent) {
      // Local-first: merge update into IndexedDB
      const base = (currentProject?.id === targetProjectId ? currentProject : null)
        ?? validateIdbRecord<Project>(await idbGetProject(targetProjectId), ['id', 'name'])
      if (!base) return
      const updated: Project = { ...base, ...data, updated_at: new Date().toISOString() }
      await idbPutProject(toIdbRecord(updated))
      set((state) => (state.currentProject?.id === targetProjectId ? { currentProject: updated } : {}))
      // Best-effort backend sync
      try { await get().syncProjectToBackend(updated) } catch (err) { console.warn('updateProject: backend sync failed:', err) }
    } else {
      const updated = await api.updateProject(targetProjectId, data)
      set((state) => (state.currentProject?.id === targetProjectId ? { currentProject: updated } : {}))
    }
  },

  deleteProject: async (id) => {
    const persistent = await StorageFactory.isStoragePersistent()
    if (!persistent) {
      await idbDeleteProject(id)
    }
    await api.deleteProject(id).catch((err) => console.warn('[projectStore] deleteProject', err))
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      currentProject: state.currentProject?.id === id ? null : state.currentProject,
    }))
  },

  setCurrentProject: (project) => set({ currentProject: project }),

  syncProjectToBackend: async (project) => {
    try {
      // Upsert: creates if missing, then updates to ensure latest data is applied
      await api.createProject({
        id: project.id,
        name: project.name,
        description: project.description ?? undefined,
        world_doc: project.world_doc ?? '',
      } as Parameters<typeof api.createProject>[0] & { id: string })
      // Always push the latest fields (world_doc may have changed after initial upsert)
      await api.updateProject(project.id, {
        name: project.name,
        description: project.description,
        world_doc: project.world_doc ?? '',
      })
    } catch {
      // best-effort
    }
  },
}))
