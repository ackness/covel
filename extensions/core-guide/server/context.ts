export interface PackageContextNote {
  id: string;
  title: string;
  content: string;
  priority: number;
}

// Placeholder provider so guide keeps a valid contribution target before
// runtime-side context loading and prompt assembly are implemented.
export const contextProvider = {
  id: "guide-context",
  async build(): Promise<PackageContextNote[]> {
    return [];
  }
};

export default contextProvider;
