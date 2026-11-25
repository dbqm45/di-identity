# di-identity

DI Identity — usługa tożsamości Delivery Intelligence Suite (krok 14 planu budowy suity, ADR 17 w `dbqm45/pdi`
`docs/17-tozsamosc-suity.md`). Jeden wystawca tokenów dla wszystkich aplikacji suity: **Keycloak 26** z realmem
`suite`, organizacje klientów, osoby logujące się przez dostawcę klienta (na start Google, DI2), uprawnienia do
produktów jako role klientów i agenci jako osobne podmioty z właścicielem (DI4). Repo powstało z
`dbqm45/di-service-template` (TypeScript + Fastify + Postgres, DA4); hosting: Hetzner Cloud (DA4a).

## Co jest w repo

| Część | Pliki | Co robi |
|---|---|---|
| Stan realmu | `keycloak/suite.json` | aplikacje suity (klienci OIDC) z rolami, które dostają e-mail (DI3), czas życia tokenów osoby (5 min) i agenta (10 min), dostawcy tożsamości |
| Klienci publiczni | `keycloak/suite.json` (`publicClients`) | narzędzia logujące osobę na jej komputerze, bez sekretu, z PKCE: `di-decision-mcp` dla zdalnego serwera MCP pdi (Claude Code, port zwrotny 33418); token tylko z rolami i odbiorcą `di-decision`, bez e-maila; zamiast dynamicznej rejestracji klientów |
| Konfiguracja | `src/keycloak/configure.ts` | doprowadza Keycloak do stanu z `suite.json`; można uruchamiać wielokrotnie; nie usuwa organizacji, osób ani agentów |
| Agenci i organizacje | `src/keycloak/agents.ts` | organizacja z domeną; agent: klient `agent-<persona>-<organizacja>` z kontem usługowym, właścicielem, celem, datą przeglądu (90 dni), `private_key_jwt`, rolami (nigdy `admin`); wyłączenie agenta i wszystkich agentów organizacji (AN6) |
| Osoby | `src/keycloak/people.ts` | dodanie osoby do organizacji i nadanie albo odebranie roli w produkcie (po e-mailu, nazwie użytkownika albo `sub`); odmawia dla agentów |
| Polecenia | `src/cli.ts` | administracja do czasu Admin Console (AC1) |
| Usługa | `src/` z szablonu | `GET /health`, `GET /api/me`; tu dojdzie API Admin Console (krok 14b) |
| Wdrożenie | `compose.yaml`, `Caddyfile`, `deploy/` | Keycloak, usługa, jeden Postgres z dwiema bazami, Caddy z TLS; konsola i API administracyjne Keycloak niedostępne z zewnątrz |

## Co niesie token (sprawdzone na Keycloak 26.4.7, 2026-11-23)

| Roszczenie | Osoba | Agent |
|---|---|---|
| `sub` | identyfikator osoby w suicie | identyfikator agenta (konto usługowe) |
| `azp` | klient aplikacji, której wydano token | `agent-<persona>-<organizacja>` |
| `organization` | lista aliasów organizacji, np. `["acme"]` | tak samo |
| `resource_access.<aplikacja>.roles` | role w danej aplikacji; w tokenie dostępu i w ID tokenie (dla aplikacji, które czytają role z ID tokenu, np. DI Release Control) | role nadane agentowi |
| `kind`, `owner` | brak | `agent` i `sub` właściciela |
| `email` | tylko dla aplikacji z `email: true` (DI3) | nigdy (szablon go pomija) |
| `preferred_username` | nazwa użytkownika; osoba od dostawcy (Google) ma `<dostawca>.<sub>`, nigdy e-mail | `service-account-agent-…` |

Dlaczego tak (sprawdzone 2026-11-25 na Keycloak 26.4.7, dostawca OIDC bez `preferred_username`, jak Google): bez
ustawień Keycloak nadaje osobie od dostawcy nazwę użytkownika równą e-mailowi, a ta trafia do każdej aplikacji jako
`preferred_username` — także do tych bez e-maila (DI3). `configure` dodaje dostawcy mapper `username from subject`
(`${ALIAS}.${CLAIM.sub}`, synchronizacja przy każdym logowaniu, więc wcześniejsze nazwy-e-maile zmieniają się przy
następnym logowaniu) i odbiera osobie prawo zmiany nazwy użytkownika (profil użytkownika realmu: edycja tylko admin;
wcześniej formularz pierwszego logowania pozwalał wpisać tam e-mail).

Keycloak dopisuje do `aud` każdą aplikację, w której podmiot ma role. Dlatego szablon przyjmuje token osoby tylko
wtedy, gdy `azp` wskazuje tę aplikację (albo klienta z `OIDC_AUTHORIZED_PARTIES`).

## API dla innych aplikacji suity

`GET /api/people?email=<adres>` zwraca osobę z suity z tym zweryfikowanym adresem e-mail: `{ sub, name, organizations }`
(404, gdy nie ma dokładnie jednej takiej osoby; agentów nigdy). Tylko dla tokenu konta usługowego aplikacji z listy
`OIDC_SERVICE_CLIENTS` z rolą `di-identity:people-reader` (na start DI Channels: osoba ze Slacka → osoba w suicie).
Usługa czyta użytkowników kontem usługowym klienta `di-identity`; role w `realm-management` nadaje `configure`
(`serviceRoles` i `identityServiceAccount` w `keycloak/suite.json`). Włącza je `DI_IDENTITY_CLIENT_SECRET`.

## Admin Console (AC1)

`/admin` — ekran administratora organizacji klienta ([plan](docs/plan-admin-console.md)): ludzie organizacji z rolami
w produktach (dodanie po e-mailu osoby, która raz się zalogowała; usunięcie; nadanie i odebranie roli), agenci
organizacji (wyłączenie, włączenie, wyłącznik wszystkich — AN6) i dziennik zmian (`admin_events`, kto i co zmienił).
Logowanie przez suitę klientem `di-admin` (kod z PKCE); wchodzi osoba z rolą `di-admin:admin` i widzi tylko
organizacje ze swojego tokenu; ostatni administrator organizacji nie odbierze sobie tej roli i nie usunie siebie.
Sesje w Postgresie (`admin_sessions`, tylko skrót ciasteczka, 12 h); każda zmiana wymaga tokenu formularza i nagłówka
Origin z tej konsoli. Strony bez JavaScriptu.

Zmiany robi konto usługowe `di-identity`. Najmniejszy zestaw ról, który przechodzi test na Keycloak 26.4.7
(2026-11-25): `view-users`, `query-users`, `manage-users`, `view-clients`, `manage-clients` i **`manage-realm`** —
API organizacji odpowiada 403 bez `manage-realm`, nawet na odczyt. To szerokie uprawnienie (ustawienia całego realmu),
więc sekret klienta `di-identity` trzeba chronić jak hasło administratora Keycloak.

Włączenie: `ADMIN_CLIENT_SECRET` (albo `SUITE_CLIENT_SECRET_DI_ADMIN` z `secrets`), `KEYCLOAK_URL`, sekret
`di-identity`; w realmie adres `REDIRECT_DI_ADMIN=<ADMIN_PUBLIC_URL>/*` przed `configure`. Lokalnie:
`http://127.0.0.1:3200/admin`. Pierwszego administratora organizacji nadaje się poleceniem:
`npm run identity -- role grant di-admin:admin <osoba>`.

## Polecenia

Uruchamiane na maszynie z Keycloak, wobec adresu wewnętrznego (`KEYCLOAK_URL`); w compose przez usługę `admin`:

```sh
docker compose run --rm admin configure
docker compose run --rm admin org create acme "Acme" acme.com
docker compose run --rm admin org add-member acme ola@acme.com      # po pierwszym logowaniu osoby
docker compose run --rm admin role grant di-release-control:admin ola@acme.com
docker compose run --rm admin role revoke di-release-control:admin ola@acme.com
docker compose run --rm admin agent create tomasz --org acme --owner <sub-osoby> \
  --purpose "architekt fabryki" --key agent-keys/tomasz-acme.jwk.json --role di-decision:viewer
docker compose run --rm admin agent list --org acme
docker compose run --rm admin agent disable agent-tomasz-acme
docker compose run --rm admin agent disable-all --org acme      # wyłącznik organizacji
```

Sekrety klientów aplikacji (Keycloak generuje je sam) bez kopiowania z konsoli: `secrets` zapisuje je do pliku env jako
`SUITE_CLIENT_SECRET_<KLIENT>` (np. `SUITE_CLIENT_SECRET_DI_CHANNELS`). Pozostałe linie pliku zostają, plik ma prawa
0600, a wartości nie trafiają na ekran ani do logu. Ta usługa czyta stamtąd swój sekret
(`SUITE_CLIENT_SECRET_DI_IDENTITY`), więc po tym poleceniu API wyszukiwania osób działa bez `DI_IDENTITY_CLIENT_SECRET`.

```sh
npm run identity -- configure
npm run identity -- secrets --env-file .env          # lokalnie; pdi: sdlc up robi to samo do ~/.sdlc/env
```

Klucz agenta: para RSA, do Keycloak trafia tylko publiczny JWK (polecenie odrzuca klucz z częścią prywatną).
Prywatny klucz zostaje u tego, kto uruchamia agenta, poza kontenerem fazy (DZ9).

## Uruchomienie lokalne

```sh
npm ci
docker run -d --name keycloak -p 8080:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin keycloak/keycloak:26.4 start-dev
KEYCLOAK_URL=http://localhost:8080 KEYCLOAK_ADMIN_USERNAME=admin KEYCLOAK_ADMIN_PASSWORD=admin npm run identity -- configure
KEYCLOAK_URL=http://localhost:8080 npm test        # z testem na prawdziwym Keycloak (test/keycloak.test.ts)
```

Usługa lokalnie, obok innych aplikacji suity (porty: Flags API 3000, di-channels 3100, DI Definition 4317; Keycloak
na 8180, bo 8080 bywa zajęty):

```sh
docker run -d --name di-identity-db -e POSTGRES_USER=identity -e POSTGRES_PASSWORD=identity \
  -e POSTGRES_DB=identity -p 127.0.0.1:5433:5432 postgres:17
# .env: PORT=3200, DATABASE_URL=postgres://identity:identity@localhost:5433/identity, DATABASE_SSL=false,
#       OIDC_ISSUER=http://localhost:8180/realms/suite, KEYCLOAK_URL=http://localhost:8180, DI_IDENTITY_CLIENT_SECRET
npm start                       # bez ostrzeżenia „people lookup is off”
curl http://127.0.0.1:3200/health
```

Adres `127.0.0.1` zamiast `localhost`: na macOS `localhost` trafia najpierw w IPv6 (`::1`), a usługa słucha tylko na
`127.0.0.1`. Inna aplikacja słuchająca na tym samym porcie pod `::1` odpowie wtedy zamiast niej.

Test na Keycloak pracuje na własnym realmie `suite-test-<przebieg>` z definicją z `keycloak/suite.json` i usuwa go na
koniec, więc lokalny realm `suite` (adresy przekierowań, organizacje, osoby) zostaje nietknięty. Tworzy w nim
organizację, osobę z hasłem i publicznego klienta testowego: tylko w teście, realm `suite` nie ma logowania hasłem.

## Wdrożenie (Hetzner Cloud)

1. Maszyna w UE z Dockerem (Keycloak potrzebuje ok. 1–2 GB RAM, całość ok. 4 GB); domena, np. `id.example.com`,
   wskazuje na jej adres.
2. Google Cloud: klient OAuth typu „Web application”, adres przekierowania
   `https://<domena>/realms/suite/broker/google/endpoint`, zakresy `openid email profile` (ADR 17 §2.3).
3. Na maszynie: klon repo, `.env` z `.env.example` (domena, hasła baz, administrator Keycloak, klient Google,
   adresy przekierowań aplikacji), potem `docker compose up -d --build` i `docker compose run --rm admin configure`.
4. Po pierwszym logowaniu do konsoli Keycloak (tunel SSH do `keycloak:8080`): stały administrator w realmie
   `master` zamiast tymczasowego, nowe hasło w `.env`.
5. Kopie zapasowe: `pg_dump` obu baz (`identity`, `keycloak`) codziennie poza maszynę — do ustalenia przy
   wdrożeniu (procedura jeszcze nie spisana).

## Niesprawdzone albo jeszcze nie zrobione

- Logowanie przez prawdziwe konto Google: wymaga klienta OAuth właściciela; sprawdzone tylko, że dostawca
  `google` jest skonfigurowany i strona logowania `di-release` pokazuje przycisk Google.
- Strona logowania nadal ma formularz nazwy i hasła (osoby nie mają haseł, więc nie da się nim zalogować);
  ukrycie formularza albo logowanie „najpierw e-mail” z przekierowaniem do dostawcy organizacji — osobny krok.
- Powiązanie dostawcy tożsamości z organizacją (przekierowanie po domenie e-mail) i dołączanie osoby do
  organizacji po domenie `hd` z Google: do zrobienia razem z AC1.
- Pełny stos w compose (obraz usługi i Caddy z certyfikatem) nie był uruchomiony: obraz buduje CI; lokalnie
  sprawdzony Keycloak w trybie `start` z Postgresem z `compose.yaml` i poprawność `Caddyfile`.
