const CONTRACT = "examples/note-format@1";

export default async function providers(ctx) {
  const providers = (await ctx.services.discover(CONTRACT))
    .filter((service) => service.name === "format-note")
    .map(({ pluginId, name, description }) => ({
      pluginId,
      name,
      ...(description === undefined ? {} : { description }),
    }))
    .sort((left, right) =>
      left.pluginId < right.pluginId
        ? -1
        : left.pluginId > right.pluginId
          ? 1
          : left.name < right.name
            ? -1
            : left.name > right.name
              ? 1
              : 0,
    );

  return { outcome: "success", value: { providers } };
}
