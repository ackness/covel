import type { PluginRegistry } from "@covel/plugin-loader";
import type { DataStore, MediaStore, StoreBackend } from "@covel/store";

export type SessionRouteEnv = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
    mediaStore?: MediaStore;
    worldsDirs?: readonly string[];
    covelHome?: string;
    storeBackend?: StoreBackend;
  };
};
