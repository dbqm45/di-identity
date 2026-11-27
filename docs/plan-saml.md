# Logowanie przez dostawcę SAML organizacji — plan

Stan: 2026-11-27, zrobione i sprawdzone na żywo. Właściciel zlecił zrobić to według rekomendacji. Ciąg dalszy AC1b.2
([`plan-admin-console-ac1b.md`](plan-admin-console-ac1b.md) decyzja 3: „najpierw tylko OIDC, SAML osobno”).

## Co jest dziś (sprawdzone 2026-11-27, Keycloak 26.4.7)

- Strona **Sign-in** w konsoli administratora zakłada dla organizacji jednego dostawcę OIDC `org-<alias>`. Ma on
  `trustEmail: false`, pierwsze logowanie `first broker login - create only`, nazwę użytkownika z `sub`, ukrycie na
  stronie logowania oraz powiązanie z organizacją i jej domeną (identity-first).
- Metadane OIDC konsola pobiera sama (`src/admin/discovery.ts`): https, adresy publiczne, bez przekierowań, limit czasu
  i rozmiaru.
- Keycloak ma dostawcę `saml` i rozbiera metadane SAML przesłane jako plik
  (`POST /admin/realms/<realm>/identity-provider/import-config`, multipart `providerId=saml`, `file`). Zwraca
  `idpEntityId`, `singleSignOnServiceUrl`, `signingCertificate`, `nameIDPolicyFormat`, `postBinding*`,
  `wantAuthnRequestsSigned`.

## Decyzje (według rekomendacji)

1. **Jeden dostawca na organizację, OIDC albo SAML.** Ta sama nazwa `org-<alias>`; na stronie **Sign-in** admin wybiera
   rodzaj. Zmiana rodzaju zastępuje poprzedniego dostawcę; osoby, które on założył, zostają.
2. **Metadane SAML z adresu, pobierane przez konsolę.** Admin podaje adres metadanych dostawcy (https). Konsola pobiera
   je z tymi samymi zabezpieczeniami co metadane OIDC (bez przekierowań, adresy publiczne, limit czasu i rozmiaru;
   lokalnie także localhost po http), a Keycloak tylko je rozbiera (`import-config` z plikiem). Keycloak sam niczego
   nie pobiera spod adresu od klienta.
3. **Te same zasady co przy OIDC:**
   - `trustEmail: false`;
   - pierwsze logowanie tylko tworzy nowe konto i nigdy nie łączy go z istniejącym;
   - nazwa użytkownika z identyfikatora SAML (`${ALIAS}.${NAMEID}`, mapper `saml-username-idp-mapper`, DI3), nigdy z
     e-maila;
   - ukryty na stronie logowania, powiązany z organizacją i jej domeną;
   - role nadaje konsola.
4. **Bezpieczeństwo odpowiedzi:** wymagany podpis (`validateSignature`, `wantAssertionsSigned`), certyfikat z
   metadanych, identyfikator trwały (`persistent` NameID, `principalType: SUBJECT`), odpowiedź przez POST. Metadane bez
   certyfikatu podpisu albo bez adresu logowania są odrzucane.
5. **Dla dostawcy:** strona pokazuje adres metadanych suity jako usługodawcy
   (`<issuer>/broker/org-<alias>/endpoint/descriptor`) i adres odpowiedzi
   (`<issuer>/broker/org-<alias>/endpoint`). To trzeba wpisać po stronie dostawcy.
6. **Bez nowej zależności** (Keycloak rozbiera XML; konsola nie parsuje go sama) i bez zmiany kontraktu.

## Kroki

1. Czerwone testy: konsola (wybór SAML, adres metadanych, odmowy), Keycloak (dostawca SAML z metadanych drugiego realmu,
   zasady z decyzji 3–4, przejście SAML ↔ OIDC).
2. Kod: `discoverSaml` w `discovery.ts`, `setOrgSamlProvider` w `org-provider.ts`, katalog, trasy, strona.
3. Na żywo: drugi realm Keycloaka jako dostawca SAML organizacji `acme`; osoba z domeny `acme.com` loguje się do konsoli
   pdi przez SAML i dostaje nowe konto członka `acme`, z nazwą użytkownika z NameID i bez e-maila w produktach.
4. README, instrukcja użytkownika w pdi (rozdział „Administracja organizacji”).

## Co wyszło przy wdrożeniu (2026-11-27)

- **Profil z atrybutów:** Keycloak jako dostawca SAML domyślnie nie wysyła e-maila ani imienia. Bez nich pierwsze
  logowanie zatrzymywało się na formularzu „Update Account Information”. Dostawca w suicie pobiera więc przy pierwszym
  logowaniu (`syncMode: IMPORT`) e-mail, imię i nazwisko z atrybutów X.500 (`urn:oid:0.9.2342.19200300.100.1.3`,
  `2.5.4.42`, `2.5.4.4`) albo z roszczeń Microsoftu (Entra ID, AD FS). Gdy dostawca ich nie wyśle, osoba raz
  uzupełnia formularz. E-mail zostaje niezweryfikowany.
- **Zmiana rodzaju:** Keycloak nie zmienia typu istniejącego dostawcy, więc przejście OIDC ↔ SAML odłącza go od
  organizacji, usuwa i zakłada od nowa pod tą samą nazwą. Konta, które założył, zostają.
- **Na żywo** (lokalny Keycloak 26.4.7, konsola, Playwright): realm `acme-saml` jako dostawca SAML organizacji `acme`
  (klient z `saml.assertion.signature`, trwały NameID, atrybuty X.500). `adm.test` zapisał adres metadanych, a
  zaproszona osoba `saml.ola@acme.com` zalogowała się u dostawcy i dołączyła do `acme`. Powstało nowe konto
  `org-acme.g-…` z niezweryfikowanym e-mailem i powiązaniem tylko z `org-acme`. W dzienniku: `provider_set`
  „SAML <adres metadanych> (acme.com)”.
