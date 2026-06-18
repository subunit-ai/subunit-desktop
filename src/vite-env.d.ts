/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** atlas-api base URL. Dev sidecar: http://127.0.0.1:7850. Cloud: https://atlas-api.subunit.ai */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
