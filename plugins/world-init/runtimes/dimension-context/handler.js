export default async function handler(ctx) {
  if (ctx.world.dimensionProviderPluginId !== ctx.pluginId)
    throw new Error("Authoritative dimension provider unavailable");
  return { outcome: "success", value: ctx.world.dimensions };
}
