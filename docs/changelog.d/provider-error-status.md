### Fixed

- **Provider failures keep their HTTP status when the response is empty or not JSON.** Authentication errors are recorded as `auth`, error messages keep a bounded body preview, and calls that cannot be retried report a failed call instead of exhausted retries. See [model failure reasons](../reference/slots.md).
