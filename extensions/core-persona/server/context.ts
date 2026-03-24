export interface PackageContextNote {
  id: string;
  title: string;
  content: string;
  priority: number;
}

// Placeholder provider so the manifest stays truthful while persona context
// remains staged outside the runtime execution path.
export const contextProvider = {
  id: "persona-context",
  async build(): Promise<PackageContextNote[]> {
    return [];
  }
};

export default contextProvider;
