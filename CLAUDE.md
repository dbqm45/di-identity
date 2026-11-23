# CLAUDE.md

DI Identity — usługa tożsamości suity na Keycloak (opis w `README.md`, po polsku). Repo z `dbqm45/di-service-template`;
zasady szablonu obowiązują, poprawki wspólne dla wszystkich usług trafiają najpierw do szablonu.

- Kod po angielsku, TypeScript `strict`, uruchamiany przez Node bez kompilacji (type stripping): tylko składnia
  wymazywalna (`erasableSyntaxOnly`), importy względne z rozszerzeniem `.ts`.
- Zależności w czasie działania: tylko `fastify` i `pg`; nowa zależność tylko z uzasadnieniem w treści commita.
  Kryptografia (JWT, HMAC) na `node:crypto`; Keycloak tylko przez jego REST API.
- Stan realmu tylko w `keycloak/suite.json` i `src/keycloak/configure.ts`; nie zmieniaj go ręcznie w konsoli.
  `configure` musi dać się uruchomić wielokrotnie i nigdy nie usuwa organizacji, osób ani agentów.
- Nigdy: logowania hasłem dla osób (`directAccessGrantsEnabled`), samodzielnej rejestracji, zakresu `email` poza
  klientami z `email: true` (DI3), roli `admin` dla agenta, agenta bez właściciela (DI4).
- Konsola i API administracyjne Keycloak oraz realm `master` nie mogą być dostępne z zewnątrz (`Caddyfile`).
- Każda trasa z danymi: `requireIdentity`, a gdzie trzeba `requireRole`; trasy zmieniające uprawnienia: także
  `requireHuman`. Zdarzenia od innych usług: podpis `X-DI-Signature`, potem koperta wg `contract/`.
- Nie loguj tokenów, sekretów, kluczy, podpisów ani haseł.
- `contract/` to przypięta kopia `dbqm45/di-contract`: zmiana wersji w `tools/contract-pin.json`, potem
  `npm run contract:sync`.
- Zmiana schematu bazy usługi tylko nową migracją `migrations/NNN_opis.sql`.
- Przed commitem: `npm run typecheck && npm test` (z `KEYCLOAK_URL`, gdy zmiana dotyczy `src/keycloak/`); CI robi to
  samo z Postgresem i Keycloak.
- Commity i tytuły PR: Conventional Commits po angielsku, tryb rozkazujący, bez kropki, ≤ 72 znaki, zakres małymi
  literami. Praca na gałęzi, PR do `main`, scalanie squash. Wersję i `CHANGELOG.md` ustawia workflow Release.
