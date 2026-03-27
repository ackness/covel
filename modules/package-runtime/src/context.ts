import type { SupportedLocale } from "../../contracts/src/index.js";
import type {
  DomainRepositories,
  PackageStateRepository,
  Session,
  World
} from "../../domain/src/index.js";
import type { CommandExecutionContext } from "../../command-system/src/index.js";

export interface PackageContextFragment {
  id: string;
  title: string;
  content: string;
  priority: number;
  channel?: "instruction" | "memory" | "state" | "reference";
  pinned?: boolean;
  tokenCost?: number;
}

export interface PackageContextProviderInput {
  sessionId: string;
  worldId: string;
  prompt: string;
  locale: SupportedLocale;
}

export interface PackageContextRepositories {
  worlds?: DomainRepositories["worlds"];
  sessions?: DomainRepositories["sessions"];
  messages?: DomainRepositories["messages"];
  artifacts?: DomainRepositories["artifacts"];
  memoryDocuments?: DomainRepositories["memoryDocuments"];
  packageState?: PackageStateRepository;
}

export interface PackageContextProviderExecutionContext extends CommandExecutionContext {
  locale?: SupportedLocale;
  session?: Session | null;
  world?: World | null;
  repositories?: PackageContextRepositories;
  ingestionRegistry?: {
    get(sourceKey: string): unknown;
  };
  runtimePreset?: {
    id: string;
    provider?: string;
    model?: string;
  };
}
