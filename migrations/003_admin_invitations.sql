-- Admin Console, stage AC1b.1 (docs/plan-admin-console-ac1b.md): invitations by link. Only a SHA-256 of the token is
-- kept; an invitation binds the token, not an address (no e-mail stored, DI3), and is used once.
CREATE TABLE admin_invitations (
    id uuid PRIMARY KEY,
    token_hash text NOT NULL UNIQUE,
    organization text NOT NULL,
    roles text[] NOT NULL,
    created_by_sub text NOT NULL,
    created_by_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    used_by_sub text,
    revoked_at timestamptz
);

CREATE INDEX admin_invitations_organization ON admin_invitations (organization, created_at DESC);
