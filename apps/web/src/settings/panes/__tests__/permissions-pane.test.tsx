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

  it("aggregates diagnostics, manages L4 session grants, and gates desktop security boundaries to Electron", async () => {
    apiMocks.isDesktopApp.mockReturnValue(true);
    apiMocks.getPermissionsSnapshot.mockResolvedValue(buildSnapshot());
    apiMocks.listPermissionPlugins.mockResolvedValue([COMMUNITY_CODE_PLUGIN]);
    apiMocks.listInstalledPlugins.mockResolvedValue([
      {
        id: "broken-plugin",
        hostState: "error",
        error: "SyntaxError in PLUGIN.md",
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

    expect(await screen.findByText("SyntaxError in PLUGIN.md")).toBeTruthy();
    expect(screen.getByText(/probe@1 · probe \(error: timeout\)/)).toBeTruthy();
    expect(
      screen.getByText("Desktop shell security boundaries (read-only)"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(apiMocks.revokeSessionApprovals).toHaveBeenCalledWith(
        "sess-1",
        "community-script",
      ),
    );
  });
});
