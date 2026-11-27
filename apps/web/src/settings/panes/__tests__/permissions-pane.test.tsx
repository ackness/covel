import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDiagnosticsSnapshot, PluginSummary } from "@covel/shared";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_KEYS,
  resolveEffectiveCapability,
  type CapabilityCeiling,
  type CapabilityKey,
  type CapabilityPolicyMode,
  type EffectiveCapabilityState,
} from "@covel/shared/permissions";
import i18n from "@/i18n";
import type {
  PermissionPluginSummary,
  PermissionsSnapshot,
} from "@/services/api/permissions.js";
import type { SessionApprovalsSnapshot } from "@/services/api/approvals.js";
import { PermissionsPane } from "../PermissionsPane.js";

const apiMocks = vi.hoisted(() => ({
  getPermissionsSnapshot: vi.fn(),
  updatePermissionsPolicy: vi.fn(),
  listPermissionPlugins: vi.fn(),
  setPluginGrants: vi.fn(),
  deletePluginGrants: vi.fn(),
  listInstalledPlugins: vi.fn(),
  getSessionApprovals: vi.fn(),
  revokeSessionApprovals: vi.fn(),
  getPluginDiagnostics: vi.fn(),
  isDesktopApp: vi.fn(() => false),
  isOperatorTokenRequired: vi.fn(() => false),
  getOperatorToken: vi.fn(() => undefined),
  bumpPlatformInstanceDataVersion: vi.fn(),
}));

vi.mock("@/services/api/permissions.js", () => ({
  getPermissionsSnapshot: apiMocks.getPermissionsSnapshot,
  updatePermissionsPolicy: apiMocks.updatePermissionsPolicy,
  listPermissionPlugins: apiMocks.listPermissionPlugins,
  setPluginGrants: apiMocks.setPluginGrants,
  deletePluginGrants: apiMocks.deletePluginGrants,
}));

vi.mock("@/services/api/plugins.js", () => ({
  listInstalledPlugins: apiMocks.listInstalledPlugins,
}));

vi.mock("@/services/api/approvals.js", () => ({
  getSessionApprovals: apiMocks.getSessionApprovals,
  revokeSessionApprovals: apiMocks.revokeSessionApprovals,
}));

vi.mock("@/services/api/plugin-diagnostics.js", () => ({
  getPluginDiagnostics: apiMocks.getPluginDiagnostics,
}));

vi.mock("@/lib/desktop-bridge.js", () => ({
  isDesktopApp: apiMocks.isDesktopApp,
}));

vi.mock("@/lib/platform-ui-events.js", () => ({
  bumpPlatformInstanceDataVersion: apiMocks.bumpPlatformInstanceDataVersion,
}));

vi.mock("@/services/api/health.js", () => ({
  isOperatorTokenRequired: apiMocks.isOperatorTokenRequired,
}));

vi.mock("@/services/session-credentials.js", () => ({
  getOperatorToken: apiMocks.getOperatorToken,
}));

vi.mock("../TrustedSourcesCard.js", () => ({
  TrustedSourcesCard: () => <div>Trusted sources stub</div>,
}));

vi.mock("../OperatorAccessPane.js", () => ({
  OperatorAccessPane: () => <div>Operator access stub</div>,
}));

function openTab(name: RegExp | string) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

function buildSnapshot(options?: {
  form?: "personal" | "browser-private" | "hosted";
  settable?: boolean;
  overrides?: Partial<Record<CapabilityKey, CapabilityPolicyMode>>;
  ceilings?: Partial<Record<CapabilityKey, CapabilityCeiling>>;
}): PermissionsSnapshot {
  const form = options?.form ?? "personal";
  const settable = options?.settable ?? true;
  const overrides = options?.overrides ?? {};
  const capabilities = Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [key, options?.ceilings?.[key] ?? "enabled"]),
  ) as Record<CapabilityKey, CapabilityCeiling>;
  const effective = Object.fromEntries(
    CAPABILITY_KEYS.map((key) => {
      const def = CAPABILITY_CATALOG[key];
      const policy = overrides[key] ?? def.defaultPolicy;
      return [
        key,
        resolveEffectiveCapability({
          ceiling: capabilities[key],
          policy,
        }),
      ];
    }),
  ) as Record<CapabilityKey, EffectiveCapabilityState>;

  return {
    deploymentForm: form,
    capabilities,
    policy: {
      overrides,
      effective,
      source: settable ? "default" : "env",
      settable,
    },
    catalog: CAPABILITY_CATALOG,
  };
}

function emptyEffective(
  overrides?: Partial<Record<CapabilityKey, EffectiveCapabilityState>>,
): Record<CapabilityKey, EffectiveCapabilityState> {
  return Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [
      key,
      overrides?.[key] ?? {
        ceiling: "enabled",
        policy: CAPABILITY_CATALOG[key].defaultPolicy,
        effective: CAPABILITY_CATALOG[key].defaultPolicy,
      },
    ]),
  ) as Record<CapabilityKey, EffectiveCapabilityState>;
}

const COMMUNITY_CODE_PLUGIN: PermissionPluginSummary = {
  pluginId: "community-script",
  name: { en: "Community Script", zh: "社区脚本" },
  version: "1.0.0",
  source: "community",
  executionMode: "code",
  tier: 3,
  contentDigest: "sha256-abc123def456",
  integrity: "no-receipt",
  trustedSource: false,
  sourceAutoApproved: false,
  capabilities: {
    serverCode: true,
    http: [{ origin: "https://api.example.com", methods: ["POST"] }],
    hooks: [],
    tools: ["roll"],
    services: [],
    actions: [],
    wires: [],
    extensions: [],
    forms: [],
    datasets: [],
  },
  grantStatus: "none",
  grant: null,
  effectiveCapabilities: emptyEffective(),
};

const INSTANCE_PROVIDER_PLUGIN: PermissionPluginSummary = {
  pluginId: "provider-bridge",
  name: { en: "Provider Bridge" },
  version: "0.1.1",
  source: "community",
  executionMode: "code",
  tier: 3,
  contentDigest: "sha256-provider789",
  integrity: "verified",
  trustedSource: true,
  sourceAutoApproved: false,
  capabilities: {
    serverCode: true,
    instanceScope: true,
    providerSources: ["bridge"],
    flows: ["oauth-sign-in"],
    appActions: ["list-accounts"],
    secrets: true,
    authProxy: true,
    loopbackCallback: { path: "/auth/callback", ports: [1455] },
    http: [{ origin: "https://auth.example.com", methods: ["POST"] }],
    hooks: [],
    tools: [],
    services: [],
    actions: [],
    wires: [],
    extensions: [],
    forms: [],
    datasets: [],
  },
  grantStatus: "valid",
  grant: {
    pluginId: "provider-bridge",
    version: "0.1.1",
    contentDigest: "sha256-provider789",
    grantedCapabilities: {
      serverCode: true,
      instanceScope: true,
      providerSources: ["bridge"],
      flows: ["oauth-sign-in"],
      appActions: ["list-accounts"],
      secrets: true,
      authProxy: true,
      loopbackCallback: { path: "/auth/callback", ports: [1455] },
      http: [{ origin: "https://auth.example.com", methods: ["POST"] }],
      hooks: [],
      tools: [],
      services: [],
      actions: [],
      wires: [],
      extensions: [],
      forms: [],
      datasets: [],
    },
    decisions: { "plugin.communityCode": "allow" },
    grantedAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
  },
  effectiveCapabilities: emptyEffective({
    "plugin.communityCode": {
      ceiling: "enabled",
      policy: "ask",
      effective: "allow",
    },
  }),
};

const STALE_PLUGIN: PermissionPluginSummary = {
  pluginId: "stale-plugin",
  name: { en: "Stale Plugin" },
  version: "1.2.0",
  source: "community",
  executionMode: "code",
  tier: 3,
  contentDigest: "sha256-new999",
  integrity: "verified",
  trustedSource: true,
  sourceAutoApproved: false,
  capabilities: {
    serverCode: true,
    http: [],
    hooks: [],
    tools: [],
    services: [],
    actions: [],
    wires: [],
    extensions: [],
    forms: [],
    datasets: [],
  },
  grantStatus: "stale-digest",
  grant: {
    pluginId: "stale-plugin",
    version: "1.1.0",
    contentDigest: "sha256-old000",
    grantedCapabilities: {
      serverCode: true,
      http: [],
      hooks: [],
      tools: [],
      services: [],
      actions: [],
      wires: [],
      extensions: [],
      forms: [],
      datasets: [],
    },
    decisions: { "plugin.communityCode": "allow" },
    grantedAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
  },
  effectiveCapabilities: emptyEffective(),
};

describe("PermissionsPane", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    apiMocks.isDesktopApp.mockReturnValue(false);
    apiMocks.isOperatorTokenRequired.mockReturnValue(false);
    apiMocks.getOperatorToken.mockReturnValue(undefined);
    apiMocks.listInstalledPlugins.mockResolvedValue([]);
    apiMocks.listPermissionPlugins.mockResolvedValue([COMMUNITY_CODE_PLUGIN]);
    apiMocks.getSessionApprovals.mockResolvedValue({
      items: [],
      grants: [],
    } satisfies SessionApprovalsSnapshot);
    apiMocks.getPluginDiagnostics.mockResolvedValue(null);
    apiMocks.updatePermissionsPolicy.mockImplementation(
      async (policyPatch: Record<string, CapabilityPolicyMode> | null) =>
        buildSnapshot({ overrides: policyPatch ?? {} }),
    );
    apiMocks.setPluginGrants.mockResolvedValue(COMMUNITY_CODE_PLUGIN);
    apiMocks.deletePluginGrants.mockResolvedValue({
      ok: true,
      pluginId: "stale-plugin",
      revokedSessionGrants: 1,
    });
    apiMocks.revokeSessionApprovals.mockResolvedValue({ ok: true, cleared: 1 });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders L1 ceilings and L2 instance policy controls with auto-policy and lock enforcement", async () => {
    apiMocks.getPermissionsSnapshot.mockResolvedValue(
      buildSnapshot({
        ceilings: { "host.installPackages": "disabled" },
      }),
    );

    render(<PermissionsPane />);

    expect(await screen.findByText("Personal")).toBeTruthy();
    openTab(/Policy & sources/);
    expect(
      screen.queryByText("Desktop shell security boundaries (read-only)"),
    ).toBeNull();

    const codeSelect = screen.getByLabelText(
      "Community server code",
    ) as HTMLSelectElement;
    const codeOptions = within(codeSelect)
      .getAllByRole("option")
      .map((opt) => (opt as HTMLOptionElement).value);
    expect(codeOptions).toEqual(["ask", "deny"]);

    const installSelect = screen.getByLabelText(
      "Package installation",
    ) as HTMLSelectElement;
    expect(installSelect.disabled).toBe(true);

    const localBridgeSelect = screen.getByLabelText(
      "Local subprocess bridge",
    ) as HTMLSelectElement;
    expect(localBridgeSelect.disabled).toBe(true);
    expect(screen.getByText("Reserved")).toBeTruthy();

    const workerSelect = screen.getByLabelText(
      "Sandboxed compute workers",
    ) as HTMLSelectElement;
    expect(workerSelect.disabled).toBe(false);
    fireEvent.change(workerSelect, { target: { value: "deny" } });

    await waitFor(() =>
      expect(apiMocks.updatePermissionsPolicy).toHaveBeenCalledWith({
        "compute.sandboxWorker": "deny",
      }),
    );
    expect(apiMocks.bumpPlatformInstanceDataVersion).toHaveBeenCalled();
  });

  it("requires Tier 3 Danger Zone confirmation before saving L3 allow grants and supports revoking stale grants", async () => {
    apiMocks.getPermissionsSnapshot.mockResolvedValue(buildSnapshot());
    apiMocks.listPermissionPlugins.mockResolvedValue([
      COMMUNITY_CODE_PLUGIN,
      STALE_PLUGIN,
    ]);

    render(<PermissionsPane />);

    const scriptHeading = await screen.findByText("Community Script");
    const scriptCard = scriptHeading.closest("article")!;
    const grantButton = within(scriptCard).getByRole("button", {
      name: "Grant server code",
    }) as HTMLButtonElement;
    expect(grantButton.disabled).toBe(true);

    const confirmCheckbox = within(scriptCard).getByRole("checkbox");
    fireEvent.click(confirmCheckbox);
    expect(grantButton.disabled).toBe(false);

    fireEvent.click(grantButton);
    await waitFor(() =>
      expect(apiMocks.setPluginGrants).toHaveBeenCalledWith(
        "community-script",
        {
          decisions: { "plugin.communityCode": "allow" },
          expectedDigest: "sha256-abc123def456",
        },
      ),
    );
    expect(apiMocks.bumpPlatformInstanceDataVersion).toHaveBeenCalled();

    const staleHeading = screen.getByText("Stale Plugin");
    const staleCard = staleHeading.closest("article")!;
    expect(
      within(staleCard).getByText(/Package contents changed since grants/),
    ).toBeTruthy();

    fireEvent.click(
      within(staleCard).getByRole("button", {
        name: "Revoke persistent grants",
      }),
    );
    await waitFor(() =>
      expect(apiMocks.deletePluginGrants).toHaveBeenCalledWith("stale-plugin"),
    );
  });

  it.each([false, true])(
    "distinguishes a matching repository from a verified automatic grant (autoApproved=%s)",
    async (sourceAutoApproved) => {
      apiMocks.getPermissionsSnapshot.mockResolvedValue(buildSnapshot());
      apiMocks.listPermissionPlugins.mockResolvedValue([
        {
          ...COMMUNITY_CODE_PLUGIN,
          trustedSource: true,
          sourceAutoApproved,
        },
      ]);
      render(<PermissionsPane />);
      const card = (await screen.findByText("Community Script")).closest(
        "article",
      )!;
      expect(within(card).queryByText("Pending approval (1)") !== null).toBe(
        !sourceAutoApproved,
      );
      expect(within(card).queryByText(/· Trusted source/) !== null).toBe(
        sourceAutoApproved,
      );
    },
  );

  it("exposes and grants declared instance, provider-source, secret, proxy, and loopback capabilities per plugin", async () => {
    apiMocks.getPermissionsSnapshot.mockResolvedValue(buildSnapshot());
    apiMocks.listPermissionPlugins.mockResolvedValue([
      INSTANCE_PROVIDER_PLUGIN,
    ]);
    apiMocks.setPluginGrants.mockResolvedValue(INSTANCE_PROVIDER_PLUGIN);

    render(<PermissionsPane />);

    const heading = await screen.findByText("Provider Bridge");
    const card = heading.closest("article")!;
    expect(within(card).getByText("Pending approval (5)")).toBeTruthy();

    // Single-capability toggle updates one declared capability while keeping existing grants.
    const providerSourceSelect = within(card).getByLabelText(
      "Provider Bridge · Provider sources",
    ) as HTMLSelectElement;
    fireEvent.change(providerSourceSelect, { target: { value: "allow" } });
    await waitFor(() =>
      expect(apiMocks.setPluginGrants).toHaveBeenCalledWith("provider-bridge", {
        decisions: {
          "plugin.communityCode": "allow",
          "plugin.providerSource": "allow",
        },
        expectedDigest: "sha256-provider789",
      }),
    );

    // Batch button grants all 5 remaining declared capabilities in one call.
    fireEvent.click(
      within(card).getByRole("button", { name: "Approve remaining (5)" }),
    );
    await waitFor(() =>
      expect(apiMocks.setPluginGrants).toHaveBeenCalledWith("provider-bridge", {
        decisions: {
          "plugin.communityCode": "allow",
          "plugin.instanceScope": "allow",
          "plugin.providerSource": "allow",
          "secrets.own": "allow",
          "net.authProxy": "allow",
          "net.loopbackCallback": "allow",
        },
        expectedDigest: "sha256-provider789",
      }),
    );
    expect(apiMocks.bumpPlatformInstanceDataVersion).toHaveBeenCalled();
  });

  it("filters routine builtin classification noise, deduplicates diagnostics, and supports search and grouping", async () => {
    apiMocks.isDesktopApp.mockReturnValue(true);
    apiMocks.getPermissionsSnapshot.mockResolvedValue(buildSnapshot());
    apiMocks.listPermissionPlugins.mockResolvedValue([COMMUNITY_CODE_PLUGIN]);
    apiMocks.listInstalledPlugins.mockResolvedValue([
      {
        id: "affinity",
        source: "builtin",
        executionMode: "code",
        executionDiagnostics: [
          {
            file: "PLUGIN.md",
            field: "contributes.tools",
            message: "contributes.tools requires server-code authorization.",
          },
          {
            file: "PLUGIN.md",
            field: "contributes.tools",
            message: "contributes.tools requires server-code authorization.",
          },
        ],
      } as unknown as PluginSummary,
      {
        id: "broken-plugin",
        source: "community",
        hostState: "error",
        error: "SyntaxError in PLUGIN.md",
        executionMode: "code",
        executionDiagnostics: [
          {
            file: "PLUGIN.md",
            field: "entry",
            message: "entry requires server-code authorization.",
          },
          {
            file: "PLUGIN.md",
            field: "entry",
            message: "entry requires server-code authorization.",
          },
        ],
      } as unknown as PluginSummary,
    ]);
    apiMocks.getSessionApprovals.mockResolvedValue({
      items: [],
      grants: [
        { pluginId: "community-script", action: "covel:plugin-server-code" },
      ],
    });
    apiMocks.getPluginDiagnostics.mockResolvedValue({
      sessionId: "sess-1",
      capturedAt: "2026-11-22T00:00:00.000Z",
      plugins: [],
      calls: [
        {
          callId: "c1",
          callerPluginId: "narrator",
          providerPluginId: "community-script",
          name: "probe",
          contract: "probe@1",
          completedAt: "2026-11-22T00:00:00.000Z",
          durationMs: 120,
          outcome: "error",
          errorCode: "timeout",
        },
      ],
      extensionCalls: [],
      history: { scope: "process", limit: 50 },
    } satisfies PluginDiagnosticsSnapshot);

    render(<PermissionsPane sessionId="sess-1" />);

    // Session grant revocation lives on the default Plugin grants tab.
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(apiMocks.revokeSessionApprovals).toHaveBeenCalledWith(
        "sess-1",
        "community-script",
      ),
    );

    // Desktop boundaries live on the Policy & sources tab.
    openTab(/Policy & sources/);
    expect(
      screen.getByText("Desktop shell security boundaries (read-only)"),
    ).toBeTruthy();

    // Diagnostics tab excludes builtin routine notes and groups by plugin.
    openTab(/Diagnostics/);
    expect(
      screen.queryByText(
        /contributes\.tools requires server-code authorization/,
      ),
    ).toBeNull();
    expect(screen.getByText("SyntaxError in PLUGIN.md")).toBeTruthy();
    expect(screen.getByText(/probe@1 · probe \(error: timeout\)/)).toBeTruthy();
    // Duplicate community entry diagnostic collapsed into ×2 count badge.
    expect(
      screen.getAllByText(/entry requires server-code authorization/),
    ).toHaveLength(1);
    expect(screen.getByText("×2")).toBeTruthy();

    // Search filters diagnostics cleanly.
    const searchInput = screen.getByPlaceholderText(
      "Search by plugin, category, or message...",
    );
    fireEvent.change(searchInput, { target: { value: "SyntaxError" } });
    expect(screen.getByText("SyntaxError in PLUGIN.md")).toBeTruthy();
    expect(screen.queryByText(/probe@1 · probe/)).toBeNull();

    // Switch grouping mode to "By category" after clearing search.
    fireEvent.change(searchInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "By category" }));
    expect(screen.getByRole("button", { name: /Load error/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Service call/ })).toBeTruthy();
  });

  it("keeps the Danger Zone confirmation checked when saving persistent grants fails", async () => {
    apiMocks.getPermissionsSnapshot.mockResolvedValue(buildSnapshot());
    apiMocks.listPermissionPlugins.mockResolvedValue([COMMUNITY_CODE_PLUGIN]);
    apiMocks.setPluginGrants.mockRejectedValueOnce(
      new Error("digest mismatch"),
    );

    render(<PermissionsPane />);

    const scriptHeading = await screen.findByText("Community Script");
    const scriptCard = scriptHeading.closest("article")!;
    const confirmCheckbox = within(scriptCard).getByRole(
      "checkbox",
    ) as HTMLInputElement;
    fireEvent.click(confirmCheckbox);
    expect(confirmCheckbox.checked).toBe(true);

    fireEvent.click(
      within(scriptCard).getByRole("button", { name: "Grant server code" }),
    );
    expect(await screen.findByText("digest mismatch")).toBeTruthy();
    expect(confirmCheckbox.checked).toBe(true);
  });

  it("groups multiple cached session grants for the same plugin under one plugin-level Revoke button", async () => {
    apiMocks.getPermissionsSnapshot.mockResolvedValue(buildSnapshot());
    apiMocks.getSessionApprovals.mockResolvedValue({
      items: [],
      grants: [
        { pluginId: "community-script", action: "covel:plugin-server-code" },
        { pluginId: "community-script", action: "covel:event:custom" },
      ],
    });

    render(<PermissionsPane sessionId="sess-1" />);

    expect(
      await screen.findByText("covel:plugin-server-code, covel:event:custom"),
    ).toBeTruthy();
    const revokeButtons = screen.getAllByRole("button", { name: "Revoke" });
    expect(revokeButtons).toHaveLength(1);
    fireEvent.click(revokeButtons[0]!);
    await waitFor(() =>
      expect(apiMocks.revokeSessionApprovals).toHaveBeenCalledWith(
        "sess-1",
        "community-script",
      ),
    );
  });
});
