/** Session-owned character state, shared by proposal readers and stores. */
export interface CharacterRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly name: string;
  /**
   * Other names of the same person (a nickname, a title, the name in another
   * script), ordered and in display form. Absent when there are none. No two
   * characters of a session share a name-or-alias; `resolveCharacter` turns
   * any of them into this record.
   */
  readonly aliases?: readonly string[];
  readonly type: string;
  readonly description?: string;
  readonly fields?: unknown;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
