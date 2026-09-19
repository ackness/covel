/** Session-owned character state, shared by proposal readers and stores. */
export interface CharacterRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly fields?: unknown;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
