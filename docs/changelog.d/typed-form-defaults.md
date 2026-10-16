### Breaking

- **`create-form` number and checkbox defaults must be numbers and booleans.** String defaults such as `"5"` and `"true"` are rejected. Plugin authors must update those fields to `5` and `true`; recreate affected development forms. See `docs/reference/tools.md`.
