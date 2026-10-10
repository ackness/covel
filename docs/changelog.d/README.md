# Changelog fragments

A change that a user, plugin author, world author or operator can notice adds one file here. Nobody edits [`../CHANGELOG.md`](../CHANGELOG.md) by hand: two pull requests that each add a file never conflict, and two that each add a line to the same section always do.

## Writing a fragment

Create `docs/changelog.d/<slug>.md`. The slug is lower-case letters, digits and hyphens, and names the change (the branch name without its prefix works: `trace-retention.md`). The file is the Markdown that belongs under the release: one or more `### <Section>` headings, each followed by list items.

```markdown
### Breaking

- **Diagnostic traces older than 30 days are deleted.** `COVEL_TRACE_RETENTION_DAYS` now defaults to `30` instead of `0`. To keep everything, set it to `0` or choose "Keep everything" in Settings.

### Added

- **Trace retention is a player setting.** Settings → General has "Keep diagnostic traces" (7 / 30 / 90 days or keep everything). Precedence: `docs/guide/env-registry.md`.
```

The sections, in the order a release lists them:

| Section         | What goes in it                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Breaking`      | A contract, API shape, manifest field or stored data that an earlier version's plugin, world, client or session no longer works with |
| `Added`         | A new capability                                                                                                                     |
| `Changed`       | Existing behaviour that works differently                                                                                            |
| `Removed`       | A capability that is gone and broke nothing that is still supported                                                                  |
| `Fixed`         | A fault that is corrected                                                                                                            |
| `Security`      | A boundary that is tightened or a vulnerability that is closed                                                                       |
| `Documentation` | A documentation change worth telling a reader about                                                                                  |
| `Upgrade notes` | What someone who upgrades must do or check, when it is not already said in a `Breaking` entry                                        |

Conventions, the same as in the released sections of the changelog:

- English. One list item per change, starting with a bold sentence that states the result, then what changed and where the rule is documented.
- A `Breaking` entry says what no longer works and what the author, operator or owner of an existing development session must do. Covel supports the current contract only, so say plainly when data must be recreated.
- A change with several effects puts each under its section in the same file (often `Breaking` and `Added`).
- A change nobody outside the repository can notice (tests, a refactor, CI) needs no fragment. Nothing fails when a pull request has none; the reviewer decides.

`pnpm check` runs `pnpm check:changelog`, which fails on an unknown section, a section without an entry, text outside a section, text that is not a list item, and a file in this directory that is not a fragment.

## Reading what is pending

```bash
pnpm changelog:preview
```

prints the `[Unreleased]` section as the release will have it: the fragments in file-name order, each section in the order above.

## Releasing

```bash
pnpm changelog:release 0.0.50              # today's date
pnpm changelog:release 0.0.50 --date 2026-10-12
```

moves every pending entry under `## [0.0.50] - <date>` in `docs/CHANGELOG.md`, titles the two sections that are linked from elsewhere `Breaking changes in v0.0.50` and `Upgrade notes for v0.0.50`, and deletes the fragments. Then write the summary paragraph under the version heading and commit. A second run with nothing pending changes nothing; a run after a late fragment adds its entries to the same version. The release workflow refuses to publish a tag while a fragment remains, and `pnpm release:preflight` fails when the changelog has no section for the version in `package.json`.

## Entries already under `[Unreleased]`

Until the first release made this way, `[Unreleased]` in `docs/CHANGELOG.md` still holds entries that were written there directly, and a branch opened before fragments existed may still add to them. The release command moves them together with the fragments and removes the marker comment under the heading. From then on `pnpm check` fails when `[Unreleased]` holds an entry.
