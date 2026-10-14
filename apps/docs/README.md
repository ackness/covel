# @covel/docs

The Covel documentation site, built with [VitePress](https://vitepress.dev/).
This package is only the site shell: navigation, search, theme. The pages are
the Markdown files in [`docs/`](../../docs/), and the rules for writing
them are in [`docs/AGENTS.md`](../../docs/AGENTS.md).

```bash
pnpm --filter @covel/docs dev      # http://localhost:5175/docs/
pnpm --filter @covel/docs build    # static files in apps/docs/dist/
pnpm --filter @covel/docs preview  # serves the build on port 5175
```

- The site is published under `docs/` of the showcase site
  (`.github/workflows/site.yml` copies `dist/` into `apps/site/dist/docs`), so
  its base is `<SITE_BASE>docs/`. `SITE_BASE` is the same variable `apps/site`
  reads.
- The sidebar and the top navigation are written by hand in
  `.vitepress/config.ts`. A new page appears on the site only after it is added
  there.
- A dead link fails the build. A relative link that leaves `docs/` is turned
  into a link to the same file on GitHub (`repositoryLink` in the config), so a
  page may link to a contract page that is not part of the site yet.
- The site has two languages. The Chinese pages are the root of `docs/`
  and the English pages are `docs/en/`, at the same relative paths. The
  English navigation is built from the Chinese one with the `EN` label table
  in the config; a label missing there fails the build.
- The changelog page includes `docs/CHANGELOG.md`, and a ` ```mermaid `
  block is drawn as a diagram (`theme/Mermaid.vue`).
- Diagrams use Mermaid 12 and require an ES2024 browser (Safari 17.4+); this browser floor applies only to the documentation site.
- `README.md`, `AGENTS.md` and `CLAUDE.md` in `docs/` are for editors and
  are left out of the site.
- The colours in `.vitepress/theme/custom.css` are those of
  `apps/site/src/index.css`. Change them together.
