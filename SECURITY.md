# Security Policy

## Supported versions

Covel is in early access. Security fixes go to `main` and ship in the next
release; only the latest release is supported.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Report it privately on GitHub:
**Security → Report a vulnerability** on this repository, or
<https://github.com/ackness/covel/security/advisories/new>.

Include the version, how Covel was running (desktop app, self-hosted server, or
a hosted tier), the steps to reproduce, and what an attacker gains.

## Scope

The boundaries Covel enforces, and the reason for each, are in
[`docs/architecture/security.md`](docs/architecture/security.md). A way around
one of them is a vulnerability. Examples:

- code of a community plugin runs before the player approved it;
- a server-side or platform provider key reaches an origin that the trusted
  configuration does not name;
- the outbound request guard is led to a private or loopback address;
- a hosted tier answers a session or operator route without the right token;
- installing a plugin, world, or collection writes outside its target directory.

Not a vulnerability in Covel:

- What an approved community plugin does with the server's privileges. Plugin
  server code is not sandboxed, and approving a package means trusting its
  author; see
  [Community plugin code](docs/architecture/security.md#community-plugin-code).
- A fault in a third-party plugin or world. Report it to its author, or in the
  [plugin directory](https://github.com/covel-ai/covel-plugins) or
  [world directory](https://github.com/covel-ai/covel-worlds).
