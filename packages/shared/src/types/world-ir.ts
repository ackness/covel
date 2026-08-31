/** JSON values allowed in extensible World IR attributes. */
export type WorldIRJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly WorldIRJsonValue[]
  | { readonly [key: string]: WorldIRJsonValue };

export interface WorldIRV1Entity {
  readonly id: string;
  readonly type: string;
  readonly name?: string;
  readonly description?: string;
  readonly attributes?: Readonly<Record<string, WorldIRJsonValue>>;
}

export interface WorldIRV1Relation {
  readonly id: string;
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly description?: string;
  readonly attributes?: Readonly<Record<string, WorldIRJsonValue>>;
}

export interface WorldIRV1Event {
  readonly id: string;
  readonly type: string;
  readonly participantIds?: readonly string[];
  readonly time?: string;
  readonly description?: string;
  readonly attributes?: Readonly<Record<string, WorldIRJsonValue>>;
}

export interface WorldIRV1Statement {
  readonly id: string;
  readonly type: string;
  readonly content: string;
  readonly subjectIds?: readonly string[];
  readonly attributes?: Readonly<Record<string, WorldIRJsonValue>>;
}

/**
 * Plugin-neutral, versioned intermediate representation for authored world
 * data. Concrete plugins project this stable envelope into their own schemas.
 */
export interface WorldIRV1 {
  readonly schemaVersion: 1;
  readonly summary?: string;
  readonly entities: readonly WorldIRV1Entity[];
  readonly relations: readonly WorldIRV1Relation[];
  readonly events: readonly WorldIRV1Event[];
  readonly statements: readonly WorldIRV1Statement[];
}
