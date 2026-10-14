### Changed

- **Docker Compose and CI use pgvector 0.8.7** on PostgreSQL 18 (`pgvector/pgvector:0.8.7-pg18`, pinned by its multi-platform digest).

### Upgrade notes

- **An existing `pgdata18` volume keeps the `vector` extension at 0.8.6** until it is updated in the database. After the new image starts, run `docker compose -f docker/docker-compose.yml --env-file .env exec postgres psql -U covel -d covel -c 'ALTER EXTENSION vector UPDATE;'` (use your `POSTGRES_USER` and `POSTGRES_DB` if you changed them).
