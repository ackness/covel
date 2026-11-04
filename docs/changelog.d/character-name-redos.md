### Security

- **A long run of white space in a character name no longer stalls a lookup.** `characterNameKey` in `@covel/plugin-handlers-utils` trimmed surrounding spaces and quotation marks with an anchored regular expression that took quadratic time on such names; a model or player could pass one through any tool that resolves a character. It now trims in one pass.
