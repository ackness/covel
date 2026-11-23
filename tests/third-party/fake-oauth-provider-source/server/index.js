const SECRETS_KEY = "accounts.v1";
const REQUEST_SHAPE = {
  omit: ["temperature", "max_output_tokens"],
  force: { store: false, stream: true },
  systemAs: "instructions",
};

async function readVault(ctx) {
  const stored = await ctx.secrets.get(SECRETS_KEY);
  if (!stored || !stored.value || typeof stored.value !== "object") {
    return { activeAccountId: null, accounts: {} };
  }
  const value = stored.value;
  return {
    activeAccountId:
      typeof value.activeAccountId === "string" ? value.activeAccountId : null,
    accounts:
      value.accounts && typeof value.accounts === "object"
        ? { ...value.accounts }
        : {},
  };
}

async function writeVault(ctx, state) {
  await ctx.secrets.set(SECRETS_KEY, state);
  if (ctx.instanceData) {
    const publicAccounts = Object.values(state.accounts).map((acc) => ({
      id: acc.id,
      label: acc.label ?? acc.id,
      status: acc.status ?? "ready",
      isDefault: acc.id === state.activeAccountId,
      plan: acc.plan ?? "standard",
    }));
    await ctx.instanceData.set("accounts", "summary", {
      activeAccountId: state.activeAccountId,
      items: publicAccounts,
    });
  }
}

function summarizeAccounts(vault) {
  return Object.values(vault.accounts).map((acc) => ({
    id: acc.id,
    label: acc.label ?? acc.id,
    status: acc.status ?? "ready",
    isDefault: acc.id === vault.activeAccountId,
    plan: acc.plan ?? "standard",
  }));
}

export default function registerFakeOauthProviderSource(covel) {
  covel.registerConfigFlow("oauth-sign-in", {
    requiredCapabilities: ["secrets.own", "net.loopbackCallback"],
    async start(_input, ctx) {
      const loopback = await ctx.startLoopbackCallback();
      const params = new URLSearchParams({
        redirect_uri: loopback.callbackUrl,
        state: "fake-oauth-state",
      });
      return {
        kind: "browser",
        stepId: "await-callback",
        title: "Sign in to Fake Subscription",
        description:
          "Authorize in your browser or paste the final redirect URL.",
        authorizeUrl: `https://auth.example.test/oauth/authorize?${params.toString()}`,
        completion: "loopback-or-paste",
        callbackUrl: loopback.callbackUrl,
      };
    },
    async step(input, ctx) {
      if (input.cancelled) {
        return { kind: "done", title: "Cancelled" };
      }
      const rawUrl =
        typeof input.callbackUrl === "string"
          ? input.callbackUrl
          : typeof input.data?.callbackUrl === "string"
            ? input.data.callbackUrl
            : "";
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return {
          kind: "error",
          code: "invalid_callback",
          title: "Invalid callback URL",
          message: "Expected a valid callback URL containing a code.",
          retryable: true,
        };
      }
      const code = parsed.searchParams.get("code");
      if (!code) {
        return {
          kind: "error",
          code: "missing_code",
          title: "Missing code",
          message: "Callback URL did not include an authorization code.",
          retryable: true,
        };
      }
      const resp = await ctx.http.fetchWithRetry(
        "https://auth.example.test/oauth/token",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant_type: "authorization_code", code }),
        },
      );
      if (!resp.ok) {
        return {
          kind: "error",
          code: "token_exchange_failed",
          title: "Token exchange failed",
          message: `Token endpoint returned HTTP ${resp.status}`,
          retryable: true,
        };
      }
      const payload = await resp.json();
      const accountId =
        typeof payload.account_id === "string"
          ? payload.account_id
          : parsed.searchParams.get("account") || "acct-1";
      const vault = await readVault(ctx);
      vault.accounts[accountId] = {
        id: accountId,
        label: payload.label ?? `Account ${accountId}`,
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
        generation: 1,
        status: "ready",
        plan: payload.plan ?? "pro",
      };
      vault.activeAccountId = vault.activeAccountId ?? accountId;
      await writeVault(ctx, vault);
      return {
        kind: "done",
        title: "Signed in",
        description: `Connected account ${accountId}`,
        summary: { accountId },
        refreshSections: ["llm"],
      };
    },
  });

  covel.registerConfigFlow("paste-import", {
    requiredCapabilities: ["secrets.own"],
    async start() {
      return {
        kind: "form",
        stepId: "enter-credential",
        title: "Import Fake Subscription Token",
        fields: [
          {
            name: "accountId",
            label: "Account ID",
            type: "text",
            required: true,
            defaultValue: "acct-imported",
          },
          {
            name: "accessToken",
            label: "Access Token",
            type: "secret",
            required: true,
          },
          {
            name: "refreshToken",
            label: "Refresh Token",
            type: "secret",
            required: false,
          },
        ],
      };
    },
    async step(input, ctx) {
      const accountId =
        typeof input.data?.accountId === "string"
          ? input.data.accountId.trim()
          : "";
      const accessToken =
        typeof input.data?.accessToken === "string"
          ? input.data.accessToken.trim()
          : "";
      const refreshToken =
        typeof input.data?.refreshToken === "string"
          ? input.data.refreshToken.trim()
          : `refresh-${accountId}`;
      if (!accountId || !accessToken) {
        return {
          kind: "error",
          code: "invalid_input",
          title: "Missing credentials",
          message: "Both Account ID and Access Token are required.",
          retryable: true,
        };
      }
      const vault = await readVault(ctx);
      vault.accounts[accountId] = {
        id: accountId,
        label: `Imported (${accountId})`,
        accessToken,
        refreshToken,
        generation: 1,
        status: "ready",
        plan: "imported",
      };
      vault.activeAccountId = accountId;
      await writeVault(ctx, vault);
      return {
        kind: "done",
        title: "Credential imported",
        summary: { accountId },
        refreshSections: ["llm"],
      };
    },
  });

  covel.registerAppAction(
    "set-default-account",
    async (input, ctx) => {
      const accountId =
        input && typeof input.accountId === "string" ? input.accountId : "";
      const vault = await readVault(ctx);
      if (!vault.accounts[accountId]) {
        throw new Error(`Account "${accountId}" does not exist`);
      }
      vault.activeAccountId = accountId;
      await writeVault(ctx, vault);
      return { ok: true, activeAccountId: accountId };
    },
    { requiredCapabilities: ["secrets.own"] },
  );

  covel.registerAppAction(
    "remove-account",
    async (input, ctx) => {
      const accountId =
        input && typeof input.accountId === "string" ? input.accountId : "";
      const vault = await readVault(ctx);
      delete vault.accounts[accountId];
      if (vault.activeAccountId === accountId) {
        vault.activeAccountId = Object.keys(vault.accounts)[0] ?? null;
      }
      await writeVault(ctx, vault);
      return { ok: true, accounts: summarizeAccounts(vault) };
    },
    { requiredCapabilities: ["secrets.own"] },
  );

  covel.registerAppAction(
    "list-accounts",
    async (_input, ctx) => {
      const vault = await readVault(ctx);
      return { accounts: summarizeAccounts(vault) };
    },
    { requiredCapabilities: ["secrets.own"] },
  );

  covel.registerProviderSources([
    {
      id: "fake-sub",
      async listAccounts(ctx) {
        const vault = await readVault(ctx);
        return summarizeAccounts(vault);
      },
      async listModels(_req, ctx) {
        const resp = await ctx.http.fetchWithRetry(
          "https://auth.example.test/v1/models",
          { method: "GET" },
        );
        if (!resp.ok) {
          throw new Error(`Failed to fetch models: HTTP ${resp.status}`);
        }
        const data = await resp.json();
        return Array.isArray(data.models) ? data.models : [];
      },
      async getUsage(req, ctx) {
        const vault = await readVault(ctx);
        const accountId = req.accountId ?? vault.activeAccountId;
        const account = accountId ? vault.accounts[accountId] : undefined;
        if (!account) return null;
        const resp = await ctx.http.fetchWithRetry(
          `https://auth.example.test/v1/usage?account=${encodeURIComponent(account.id)}`,
          {
            method: "GET",
            headers: { authorization: `Bearer ${account.accessToken}` },
          },
        );
        if (!resp.ok) return null;
        return await resp.json();
      },
      async resolve(req, ctx) {
        const vault = await readVault(ctx);
        const targetId = req.accountId ?? vault.activeAccountId;
        const account = targetId ? vault.accounts[targetId] : undefined;
        if (!account) {
          throw new Error("No authenticated account available");
        }
        return {
          accountId: account.id,
          credentialGeneration: account.generation ?? 1,
          headers: {
            authorization: `Bearer ${account.accessToken}`,
            "x-fake-account": account.id,
          },
          requestShape: REQUEST_SHAPE,
        };
      },
      async refresh(req, ctx) {
        const vault = await readVault(ctx);
        const targetId = req.accountId ?? vault.activeAccountId;
        const account = targetId ? vault.accounts[targetId] : undefined;
        if (!account || !account.refreshToken) return null;
        const currentGen = account.generation ?? 1;
        if (
          req.failedGeneration !== undefined &&
          currentGen > req.failedGeneration
        ) {
          return {
            accountId: account.id,
            credentialGeneration: currentGen,
            headers: {
              authorization: `Bearer ${account.accessToken}`,
              "x-fake-account": account.id,
            },
            requestShape: REQUEST_SHAPE,
          };
        }
        const resp = await ctx.http.fetchWithRetry(
          "https://auth.example.test/oauth/token",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              grant_type: "refresh_token",
              refresh_token: account.refreshToken,
              account_id: account.id,
            }),
          },
        );
        if (!resp.ok) return null;
        const payload = await resp.json();
        const nextGeneration = currentGen + 1;
        account.accessToken = payload.access_token;
        account.refreshToken = payload.refresh_token ?? account.refreshToken;
        account.generation = nextGeneration;
        account.status = "ready";
        await writeVault(ctx, vault);
        return {
          accountId: account.id,
          credentialGeneration: nextGeneration,
          headers: {
            authorization: `Bearer ${account.accessToken}`,
            "x-fake-account": account.id,
          },
          requestShape: REQUEST_SHAPE,
        };
      },
      classifyError(error) {
        if (
          error.statusCode === 429 ||
          /rate_limit|quota_exceeded/i.test(error.message)
        ) {
          return {
            kind: "rate_limited",
            message: "Subscription account quota temporarily exhausted",
          };
        }
        return null;
      },
    },
  ]);
}
