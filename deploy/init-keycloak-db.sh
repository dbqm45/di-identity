#!/bin/sh
# Runs once, when the Postgres volume is created: a separate role and database for Keycloak, next to the service's
# own database (POSTGRES_DB). Password from KEYCLOAK_DB_PASSWORD.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE keycloak LOGIN PASSWORD '${KEYCLOAK_DB_PASSWORD}';
CREATE DATABASE keycloak OWNER keycloak;
SQL
