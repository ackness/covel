### Fixed

- **Community plugins no longer prevent the app from starting.** Plugin discovery validates the source-trust metadata returned by the server, including packages copied manually without an installation receipt. Unknown fields and malformed trust metadata are still rejected.
