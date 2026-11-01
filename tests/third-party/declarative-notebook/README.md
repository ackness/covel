# Declarative notebook

Copy this folder into the user plugin directory and run
`pnpm validate:plugin <path>/declarative-notebook`. Enable it in session preparation
or the session plugin list. It uses the configured model before each turn, and
needs no server-code or runtime approval while its current files remain declarative.
There is no entry, build step or executable test configuration in this distribution.

The agent writes only its own `notes` dataset through generated tools. Its schema,
key and operations are validated again at commit. Framework character writes, when
explicitly declared, use validated `sync-characters` proposals. Other packages' data
is accessible only through separately admitted services. The optional
`notebook.review@1` import can be absent without preventing notebook use.

The panel displays committed notes. The notebook page's classic JavaScript runs in
an isolated browser frame. Its session-read bridge needs separate consent bound to
the current page content; enabling the package does not grant that consent.

Adding an entry, function, guard, server registration, HTTP permission, or executable
file outside the validated browser assets restores code approval. Keep development
scripts and tests outside this folder. The repository's host/runtime/browser tests
exercise this exact package through public loading and execution paths.
