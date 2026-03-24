export interface PackageContextNote {
  id: string;
  title: string;
  content: string;
  priority: number;
}

// Placeholder provider so the manifest points to a concrete module until
// character-card context is connected to retrieval and prompt assembly.
export const contextProvider = {
  id: "character-card-context",
  async build(): Promise<PackageContextNote[]> {
    return [];
  }
};

export default contextProvider;
