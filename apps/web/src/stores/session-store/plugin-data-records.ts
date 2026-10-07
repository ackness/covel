/** Group one plugin's durable records for hydration and reconnect snapshots. */
export function pluginDataNamespaces(
  records: readonly { namespace: string; key: string; value: unknown }[],
): Record<string, Record<string, unknown>> {
  const namespaces: Record<string, Record<string, unknown>> = Object.create(
    null,
  );
  for (const record of records)
    (namespaces[record.namespace] ??= Object.create(null))[record.key] =
      record.value;
  return namespaces;
}
