import { z } from 'zod';

export interface MediaRef {
  /** Stable id; SHA-256 of content. */
  readonly id: string;
  /** MIME type, e.g. image/png, audio/wav, video/mp4. */
  readonly mime: string;
  /** Byte size; useful for budgeting and progress. */
  readonly size: number;
  /** Optional pre-signed URL. Resolve by id when absent. */
  readonly url?: string;
  /** Free-form metadata: dimensions, duration, provider ids, etc. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export const mediaRefSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  url: z.url().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type MediaRefSchema = z.infer<typeof mediaRefSchema>;
