# Admin Console, etap AC1b — zaproszenia i dostawca tożsamości klienta — plan

Stan: 2026-11-25, propozycja do zatwierdzenia przez właściciela. Ciąg dalszy [AC1](plan-admin-console.md) (decyzja 4:
„poza tym krokiem, każde osobno”). Źródło zakresu: `dbqm45/pdi` `docs/plan-budowy-suity.md` §2b (AC1: zaproszenia,
podłączenie dostawcy tożsamości klienta) i ADR 17 (DI1: bez własnej bazy haseł, DI2: Google najpierw, DI3: bez
e-maila poza klientami z `email: true`).

## Co jest dziś

- Osoba trafia do organizacji tylko tak: najpierw sama loguje się przez Google, potem admin dodaje ją po e-mailu (AC1,
  „They must have signed in to the suite once”).
- Lokalnie nie ma SMTP, a realm nie ma ustawionej poczty, więc Keycloak nie może wysłać zaproszenia.
- Jedynym dostawcą tożsamości jest Google (ze zmiennych `GOOGLE_*`), wspólny dla całego realmu. Nazwa użytkownika
  pochodzi z `sub` dostawcy (di-identity#7), a nie z e-maila.

## Decyzje do potwierdzenia (rekomendacja w każdej)

1. **Zaproszenie linkiem, bez wysyłania poczty (AC1b.1).**
   - Admin w konsoli tworzy zaproszenie i wybiera role w produktach.
   - Konsola pokazuje link `…/join/<token>` raz. Admin wysyła go sam, przez czat albo pocztę.
   - Tabela `admin_invitations` (migracja `003`) trzyma skrót tokenu, organizację, role, termin (7 dni), autora,
     datę użycia i osobę, która go użyła. Link działa raz: przyjęcie to warunkowy `UPDATE`.
   - Osoba otwiera link i loguje się przez suitę: Google albo dostawcę swojej organizacji, nigdy hasłem (DI1).
     Konsola dodaje ją do organizacji i nadaje role kontem usługowym. Przyjęcie trafia do dziennika zmian.
   - Konsola nie zapisuje e-maila zaproszonego (DI3). Zaproszenie wiąże token, a nie adres.
   - Na liście są zaproszenia otwarte, użyte i wygasłe. Otwarte można odwołać.
   - Wysyłka poczty dojdzie razem z hostingiem i SMTP, jako osobna decyzja.

   Rekomendacja: tak. Nie potrzeba SMTP ani rejestracji w realmie, a osoba nie musi się logować przed zaproszeniem.
2. **Kto przyjmuje zaproszenie.** Dowolna osoba z kontem suity, a nie agent (DI4). Jeśli jest już w organizacji,
   dostaje tylko brakujące role i niczego nie traci. Rola `di-admin:admin` w zaproszeniu jest dozwolona, a w
   dzienniku widać, kto ją dał. Rekomendacja: tak.
3. **Dostawca tożsamości klienta, najpierw tylko OIDC (AC1b.2).** Admin organizacji podaje w konsoli wystawcę,
   identyfikator i sekret klienta oraz domeny e-mail swojej firmy. Konsola tworzy w Keycloaku:
   - dostawcę o nazwie `org-<alias>`, powiązanego z organizacją i jej domeną. Przy logowaniu najpierw po nazwie
     Keycloak kieruje osoby z tej domeny do ich dostawcy;
   - `trustEmail: false` i pierwsze logowanie, które **tylko tworzy nowe konto i nigdy nie łączy go z istniejącym po
     e-mailu**. Dzięki temu cudzy dostawca nie przejmie konta osoby z Google;
   - nazwę użytkownika z `sub` dostawcy (jak przy Google, DI3) i ukrycie dostawcy na stronie logowania.

   Sekret zostaje tylko w Keycloaku: konsola go nie zapisuje i nie pokazuje. SAML zostaje osobnym krokiem.
   Rekomendacja: tak, ale jako drugi PR, po zaproszeniach.
4. **Uprawnienia.** Do AC1b.2 konto usługowe di-identity potrzebuje zarządzania dostawcami tożsamości. Daje to
   `manage-realm`, które już ma od AC1 [niezweryfikowane dla API dostawców i organizacji — sprawdzić testem na
   prawdziwym Keycloaku przed kodem]. Rekomendacja: najmniejszy zestaw, który przechodzi test.
5. **Poza AC1b:** łączenie konta suity z kontami GitHub i Atlassian w aplikacjach, bo to sprawa aplikacji (DI Release
   zostawił je świadomie), oraz wysyłka poczty. Rekomendacja: tak.

## Kroki

1. AC1b.1: migracja `003`, potem czerwone testy (konsola z fałszywym wystawcą i pamięcią zaproszeń jak w AC1), strona
   „Invitations”, trasa `/join/:token` (logowanie przez suitę i przyjęcie), dziennik, README, próba na żywo
   (`adm.test` zaprasza, nowa osoba z `fakegoogle` przyjmuje i dostaje rolę). Osobny PR.
2. AC1b.2: najpierw test na prawdziwym Keycloaku (dostawca powiązany z organizacją i domeną, przekierowanie po
   domenie, brak łączenia po e-mailu, nazwa z `sub`), potem strona „Identity provider” i próba na żywo z drugim
   realmem jako dostawcą klienta. Osobny PR.

## Ryzyka

- Link zaproszenia, który wycieknie, wpuści każdego, kto go otworzy, dopóki nie zostanie użyty, odwołany albo nie
  wygaśnie. Ograniczają to jedno użycie, 7 dni, odwołanie i wpis w dzienniku.
- Dostawca klienta to obca strona, która potwierdza tożsamość. Organizacja ufa mu tylko dla swoich ludzi: konto
  powstaje nowe, nie łączy się po e-mailu, a role nadaje admin organizacji, nie dostawca.
