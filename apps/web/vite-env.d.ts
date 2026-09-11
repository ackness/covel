/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ROUTER_DEVTOOLS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
