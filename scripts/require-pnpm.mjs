const userAgent = process.env.npm_config_user_agent ?? "";

if (!userAgent.startsWith("pnpm/")) {
  console.error(
    "This workspace requires pnpm from the mise toolchain. Run `mise install`, then `pnpm install`.",
  );
  process.exit(1);
}
