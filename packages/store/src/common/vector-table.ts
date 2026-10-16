export function physicalTableName(id: number, label: string): string {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`${label}: invalid model registry id ${id}`);
  }
  return `vec_mem_m${id}`;
}

export function requireCurrentTableName(
  id: number,
  tableName: string,
  label: string,
): string {
  const expected = physicalTableName(id, label);
  if (tableName !== expected) {
    throw new Error(
      `${label}: vector_models.id ${id} violates the current table_name invariant`,
    );
  }
  return expected;
}

/** JSON vector notation accepted by both pgvector and sqlite-vec. */
export function serializeVector(vector: Float32Array): string {
  return `[${Array.from(vector).join(",")}]`;
}
