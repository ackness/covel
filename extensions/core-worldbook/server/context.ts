export interface PackageContextNote {
  id: string;
  title: string;
  content: string;
  priority: number;
}

// Placeholder provider so the manifest points to a real module before
// package-owned context is wired into the runtime context/prompt pipeline.
export const contextProvider = {
  id: "worldbook-context",
  async build(): Promise<PackageContextNote[]> {
    return [];
  }
};

export default contextProvider;
