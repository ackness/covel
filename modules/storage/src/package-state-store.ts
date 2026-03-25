import type {
  DomainRepositoriesWithPackageStateAndJobs,
  JobRecord,
  PackageStateRecord
} from "../../domain/src/index.js";

export interface PackageStateStore {
  save(record: PackageStateRecord): Promise<void>;
  get(input: {
    scope: PackageStateRecord["scope"];
    ownerId: string;
    packageName: string;
    collection: string;
    key: string;
  }): Promise<PackageStateRecord | null>;
  listByCollection(input: {
    scope: PackageStateRecord["scope"];
    ownerId: string;
    packageName: string;
    collection: string;
  }): Promise<PackageStateRecord[]>;
}

export interface JobStore {
  save(record: JobRecord): Promise<void>;
  getById(id: string): Promise<JobRecord | null>;
  listBySessionId(sessionId: string): Promise<JobRecord[]>;
  listByStatus(status: JobRecord["status"]): Promise<JobRecord[]>;
}

export type StorageRepositoriesWithPackageStateAndJobs = DomainRepositoriesWithPackageStateAndJobs & {
  packageState: PackageStateStore;
  jobs: JobStore;
};
