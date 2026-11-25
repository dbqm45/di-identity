# Changelog

Notable changes, newest first. Entries are written by `npm run release` from Conventional Commits (RELEASING.md).

## [0.1.4] - 2026-11-25

### Fixed

- **keycloak:** never give people from Google their e-mail as username (#7)

## [0.1.3] - 2026-11-23

### Added

- write the client secrets into an env file (#5)

## [0.1.2] - 2026-11-23

### Added

- let suite apps find a person by verified e-mail (#3)

## [0.1.1] - 2026-11-23

### Added

- add member and role commands, roles in the ID token (#2)

## [0.1.0] - 2026-11-23

### Added

- suite realm on Keycloak 26.4 configured from `keycloak/suite.json`: organizations, product clients with roles, Google sign-in, email only for DI3 clients
- agents as Keycloak service accounts with an owner, review date, 10-minute tokens and private_key_jwt (DI4); disabling one agent or all agents of an organization
