const userAgent = process.env.npm_config_user_agent ?? "";

if (!userAgent.startsWith("pnpm/")) {
  console.error(
    "This workspace requires pnpm. Enable Corepack and run `pnpm install`.",
  );
  process.exit(1);
}
