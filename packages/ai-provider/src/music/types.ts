import type {
  ModelRequestContext,
  MusicCompositionParams,
  MusicCompositionResult,
  ProviderConfig,
} from "../types.js";

/**
 * A pluggable music-generation wire — one wire per provider request/response
 * format. Registered under an open string id, as image and speech wires are.
 *
 * A provider that answers with a job to poll does the polling inside
 * `compose`, under the request's deadline and abort signal: the caller gets
 * the finished audio or an error, never a job id.
 */
export interface MusicWire {
  readonly id: string;
  compose(
    config: ProviderConfig,
    params: MusicCompositionParams,
    context?: ModelRequestContext,
  ): Promise<MusicCompositionResult>;
}
