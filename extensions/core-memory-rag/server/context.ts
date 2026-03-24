export interface PackageContextNote {
  id: string;
  title: string;
  content: string;
  priority: number;
}

// Placeholder provider kept separate from command handlers so the manifest
// remains structurally correct before package context execution lands.
export const contextProvider = {
  id: "memory-rag-context",
  async build(): Promise<PackageContextNote[]> {
    return [];
  }
};

export default contextProvider;
