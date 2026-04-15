import type { Transport } from "./transport/transport.js";
import { HttpTransport } from "./transport/http-transport.js";
import { WorldsResource } from "./resources/worlds.js";
import { SessionsResource } from "./resources/sessions.js";
import { MessagesResource } from "./resources/messages.js";
import { CharactersResource } from "./resources/characters.js";
import { PluginDataResource } from "./resources/plugin-data.js";
import { StateResource } from "./resources/state.js";
import { ActionsResource } from "./resources/actions.js";
import { EventsResource } from "./resources/events.js";
import { HealthResource } from "./resources/health.js";
import { UiSpecsResource } from "./resources/ui-specs.js";
import { LlmConfigResource } from "./resources/llm-config.js";
import { TracesResource } from "./resources/traces.js";
import { PluginsResource } from "./resources/plugins.js";
import { LorebookResource } from "./resources/lorebook.js";

export interface ApiClientOptions {
  baseUrl?: string;
  transport?: Transport;
  fetch?: typeof globalThis.fetch;
  defaultHeaders?: () => Record<string, string>;
}

export class ApiClient {
  readonly worlds: WorldsResource;
  readonly sessions: SessionsResource;
  readonly messages: MessagesResource;
  readonly characters: CharactersResource;
  readonly pluginData: PluginDataResource;
  readonly state: StateResource;
  readonly actions: ActionsResource;
  readonly events: EventsResource;
  readonly health: HealthResource;
  readonly uiSpecs: UiSpecsResource;
  readonly llmConfig: LlmConfigResource;
  readonly traces: TracesResource;
  readonly plugins: PluginsResource;
  readonly lorebook: LorebookResource;

  constructor(opts: ApiClientOptions = {}) {
    const transport =
      opts.transport ??
      new HttpTransport({
        baseUrl: opts.baseUrl ?? "/",
        fetch: opts.fetch,
        defaultHeaders: opts.defaultHeaders,
      });

    this.worlds = new WorldsResource(transport);
    this.sessions = new SessionsResource(transport);
    this.messages = new MessagesResource(transport);
    this.characters = new CharactersResource(transport);
    this.pluginData = new PluginDataResource(transport);
    this.state = new StateResource(transport);
    this.actions = new ActionsResource(transport);
    this.events = new EventsResource(transport);
    this.health = new HealthResource(transport);
    this.uiSpecs = new UiSpecsResource(transport);
    this.llmConfig = new LlmConfigResource(transport);
    this.traces = new TracesResource(transport);
    this.plugins = new PluginsResource(transport);
    this.lorebook = new LorebookResource(transport);
  }
}
