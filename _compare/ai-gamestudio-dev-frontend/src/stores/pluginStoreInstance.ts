import * as api from '../services/api'
import { createPluginStore } from './pluginStore'

export const usePluginStore = createPluginStore(api)
