# Admin Console, etap AC1 (krok 14b planu budowy suity) — plan

Stan: 2026-11-25, propozycja do decyzji właściciela (bez kodu). Źródło zakresu: `dbqm45/pdi`
`docs/plan-budowy-suity.md` §2b (AC1: organizacja, użytkownicy, zaproszenia, uprawnienia do produktów, dostawca
tożsamości klienta, dziennik zmian) i ADR 17 §2.5. Cztery aplikacje logują już przez suitę (DI Release Control,
DI Definition, DI Release, konsola pdi), więc to, czym administrator dziś zarządza poleceniami (`npm run identity --
org add-member`, `role grant`, `agent disable-all`), dostaje ekran.

## Co jest dziś

- Funkcje już są, za CLI: `src/keycloak/people.ts` (osoba po e-mailu, nazwie albo `sub`; dodanie do organizacji;
  nadanie i odebranie roli w produkcie; odmowa dla agentów), `src/keycloak/agents.ts` (lista agentów organizacji,
  wyłączenie jednego i wszystkich — AN6).
- Realm ma klienta `di-admin` z rolą `admin` i e-mailem (DI3 dopuszcza e-mail w konsoli administratora).
- Usługa ma Postgresa (migracje w `migrations/`), weryfikację tokenów (`src/auth/oidc.ts`) i strażników
  `requireIdentity` / `requireRole` / `requireHuman`.
- Konto usługowe `di-identity` ma w Keycloaku tylko `view-users` i `query-users` (wyszukiwanie osób dla DI Channels).

## Decyzje do potwierdzenia (rekomendacja w każdej)

1. **Konsola w `di-identity`, strony HTML generowane na serwerze, bez JavaScriptu**, pod `/admin` — jak konsola pdi:
   bez nowych zależności (zostają `fastify` i `pg`), ścisłe CSP, formularze POST. Rekomendacja: tak. Osobne repo
   `di-admin` dopiero przy AC2–AC4 (§2b).
2. **Logowanie przez suitę, klient `di-admin`** (kod z PKCE, ten sam wzór co w czterech aplikacjach), **sesje w
   Postgresie** (skrót identyfikatora, 12 h; przeżywają restart). Wchodzi osoba z rolą `di-admin:admin`; zarządza
   organizacjami ze swojego tokenu (`organization`). Agent nigdy. Rekomendacja: tak.
3. **Zakres AC1 w tym kroku:**
   - **Ludzie organizacji**: lista (nazwa, e-mail, role w produktach), dodanie osoby po e-mailu (osoba musi się
     raz zalogować — jak dziś w CLI), usunięcie z organizacji.
   - **Role w produktach**: nadanie i odebranie roli każdego klienta produktu z `keycloak/suite.json` (bez
     `di-identity`); ostatni administrator organizacji nie odbierze sobie `di-admin:admin` ani nie usunie siebie.
   - **Agenci organizacji**: lista (właściciel, cel, data przeglądu, włączony), wyłączenie i włączenie jednego,
     wyłącznik wszystkich (AN6). Tworzenie agenta zostaje w CLI (klucz publiczny z pliku).
   - **Dziennik zmian**: tabela `admin_events` (organizacja, kto — `sub` i nazwa, co, czego dotyczy, kiedy); każda
     zmiana z konsoli trafia tam w tej samej operacji; strona z ostatnimi 100.
   Rekomendacja: tak.
4. **Poza tym krokiem (AC1b i dalej)**, każde osobno: zaproszenia e-mailem (Keycloak wysyła je przez SMTP, którego
   lokalnie nie ma — do tego czasu „osoba loguje się, admin ją dodaje”); podłączenie własnego dostawcy tożsamości
   klienta (SAML/OIDC); łączenie konta suity z kontem GitHub/Atlassian w aplikacjach; powiązania organizacji w
   aplikacjach (ShipScope, DI Definition, pdi — zostają w aplikacjach, konsola do nich odsyła; AC2). Rekomendacja: tak.
5. **Uprawnienia konta usługowego `di-identity` w Keycloaku**: dochodzi `manage-users` (członkostwa i role osób) i
   `view-clients`/`manage-clients` (włączanie agentów), nadawane przez `configure` jak dziś `view-users`. Dokładny
   zestaw dla endpointów organizacji w Keycloak 26 — do sprawdzenia testem na prawdziwym Keycloaku przed kodem
   (niezweryfikowane). Rekomendacja: najmniejszy zestaw, który przechodzi test.
6. **Dostęp awaryjny**: konsola Keycloaka przez tunel SSH (jak dziś, README „Wdrożenie”); bez nowego mechanizmu.
   Rekomendacja: tak.

## Kroki

1. Test na prawdziwym Keycloaku: konto usługowe z nowymi rolami robi to, co CLI dziś robi kontem administratora
   (członkostwa, role, agenci) — ustala decyzję 5.
2. Migracja `002_admin_console.sql`: `admin_sessions`, `admin_events`.
3. Logowanie (`/admin/login`, `/admin/callback`, `/admin/logout`), sesje, strażnik roli `di-admin:admin` i organizacji.
4. Strony: Ludzie, Role, Agenci, Dziennik; formularze POST z Origin/Referer, każda zmiana w dzienniku.
5. Testy z fałszywym wystawcą i na prawdziwym Keycloaku; na żywo z lokalnym Keycloakiem (konto `adm.test`).

## Ryzyka

- Konto usługowe z `manage-users` może zmienić każdą osobę realmu; ograniczenie do organizacji robi kod konsoli
  (sprawdza organizację z sesji przy każdej zmianie) — testy muszą pokryć próbę zmiany osoby spoza organizacji.
- Role w produktach są dziś realmowe dla osoby, nie per organizacja: osoba w dwóch organizacjach ma te same role
  w obu. Wystarczy przy jednej organizacji na osobę (dziś); inaczej — osobna decyzja.
