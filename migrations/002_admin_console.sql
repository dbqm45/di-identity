-- Admin Console, stage AC1 (docs/plan-admin-console.md).

-- Sessions of people signed in to the console (client di-admin): only a SHA-256 of the cookie value is kept.
CREATE TABLE admin_sessions (
    id_hash text PRIMARY KEY,
    sub text NOT NULL,
    name text NOT NULL,
    organizations text[] NOT NULL,
    csrf text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX admin_sessions_expires_at ON admin_sessions (expires_at);

-- Every change made in the console: who (the suite `sub` and the name at the time), what, about whom, when.
CREATE TABLE admin_events (
    id bigserial PRIMARY KEY,
    organization text NOT NULL,
    actor_sub text NOT NULL,
    actor_name text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_events_organization_at ON admin_events (organization, at DESC);
