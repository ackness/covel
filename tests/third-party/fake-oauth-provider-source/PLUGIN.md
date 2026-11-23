---
version: 0.1.0
apiVersion: 2
scope: instance
activationEvents:
  - onFlow:oauth-sign-in
  - onFlow:paste-import
  - onAppAction:set-default-account
  - onAppAction:remove-account
  - onAppAction:list-accounts
displayName: Fake OAuth Provider Source
description: Generic test fixture implementing OAuth config flows, secret vault storage, and a multi-account subscription provider source.
permissions:
  secrets: true
  loopbackCallback:
    path: /auth/callback
    ports: ephemeral
  http:
    - origin: https://auth.example.test
      methods:
        - GET
        - POST
contributes:
  appActions:
    - set-default-account
    - remove-account
    - list-accounts
  flows:
    - oauth-sign-in
    - paste-import
  providerSources:
    - id: fake-sub
      label: Fake Subscription
      protocol: openai-responses-v1
      modes:
        - text
      baseUrl: http://127.0.0.1:18765/backend-api
      auth:
        flows:
          - oauth-sign-in
          - paste-import
      accounts: many
  ui:
    settingsSection:
      - ./ui/settings-section.json
---

# Fake OAuth Provider Source

Generic test-only fixture exercising `provider.source@1` with `SecretVault`,
declarative `ConfigFlow`s, and `loopbackCallback`.
