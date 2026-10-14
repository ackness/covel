### Fixed

- Function runtime text, object, and evaluation calls use the remaining execution time instead of an extra 120-second gateway ceiling. HTTP retries, fallback targets, and a stalled resend share one transport allowance.
- The process-wide text concurrency limit now covers gateway calls from functions, background jobs, and direct callers as well as agents. Streams hold their slot until they finish or stop; queued agent calls retain their execution-time credit.
