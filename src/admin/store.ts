import type pg from 'pg';

/**
 * Sessions and the change log of the admin console (docs/plan-admin-console.md). A session is found by the SHA-256 of
 * its cookie value; the value itself is never stored.
 */
export interface AdminSession {
  sub: string;
  name: string;
  organizations: string[];
  /** Hidden in every form; a change without it is refused. */
  csrf: string;
  expiresAt: Date;
}

export interface AdminEvent {
  organization: string;
  actorSub: string;
  actorName: string;
  kind: string;
  subject: string;
  at?: Date;
}

/** An invitation by link (docs/plan-admin-console-ac1b.md); found by the SHA-256 of its token. */
export interface Invitation {
  id: string;
  organization: string;
  /** Product roles as `<client>:<role>`. */
  roles: string[];
  createdBySub: string;
  createdByName: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  usedBySub: string | null;
  revokedAt: Date | null;
}

export type NewInvitation = Pick<Invitation, 'id' | 'organization' | 'roles' | 'createdBySub' | 'createdByName' | 'expiresAt'>;

export interface AdminStore {
  saveSession(idHash: string, session: AdminSession): Promise<void>;
  session(idHash: string): Promise<AdminSession | null>;
  endSession(idHash: string): Promise<void>;
  record(event: AdminEvent): Promise<void>;
  /** The organization's latest events, newest first. */
  latest(organization: string, limit: number): Promise<AdminEvent[]>;
  createInvitation(tokenHash: string, invitation: NewInvitation): Promise<void>;
  /** The organization's invitations, newest first. */
  invitations(organization: string): Promise<Invitation[]>;
  invitationByHash(tokenHash: string): Promise<Invitation | null>;
  /** Marks it used by `sub`, only if still open at `at`; false when it was not (used, revoked or expired meanwhile). */
  useInvitation(id: string, sub: string, at: Date): Promise<boolean>;
  /** Revokes an open invitation of the organization; false when there was none. */
  revokeInvitation(organization: string, id: string, at: Date): Promise<boolean>;
}

interface InvitationRow {
  id: string; organization: string; roles: string[]; created_by_sub: string; created_by_name: string; created_at: Date; expires_at: Date;
  used_at: Date | null; used_by_sub: string | null; revoked_at: Date | null;
}
const INVITATION_COLUMNS = 'SELECT id, organization, roles, created_by_sub, created_by_name, created_at, expires_at, used_at, used_by_sub, revoked_at FROM admin_invitations';
const fromRow = (r: InvitationRow): Invitation => ({
  id: r.id, organization: r.organization, roles: r.roles, createdBySub: r.created_by_sub, createdByName: r.created_by_name, createdAt: r.created_at,
  expiresAt: r.expires_at, usedAt: r.used_at, usedBySub: r.used_by_sub, revokedAt: r.revoked_at,
});

export function postgresAdminStore(pool: pg.Pool): AdminStore {
  return {
    async saveSession(idHash, s) {
      await pool.query('DELETE FROM admin_sessions WHERE expires_at < now()');
      await pool.query(
        'INSERT INTO admin_sessions (id_hash, sub, name, organizations, csrf, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [idHash, s.sub, s.name, s.organizations, s.csrf, s.expiresAt],
      );
    },
    async session(idHash) {
      const { rows } = await pool.query<{ sub: string; name: string; organizations: string[]; csrf: string; expires_at: Date }>(
        'SELECT sub, name, organizations, csrf, expires_at FROM admin_sessions WHERE id_hash = $1 AND expires_at > now()',
        [idHash],
      );
      const r = rows[0];
      return r ? { sub: r.sub, name: r.name, organizations: r.organizations, csrf: r.csrf, expiresAt: r.expires_at } : null;
    },
    async endSession(idHash) {
      await pool.query('DELETE FROM admin_sessions WHERE id_hash = $1', [idHash]);
    },
    async record(e) {
      await pool.query(
        'INSERT INTO admin_events (organization, actor_sub, actor_name, kind, subject) VALUES ($1, $2, $3, $4, $5)',
        [e.organization, e.actorSub, e.actorName, e.kind, e.subject.slice(0, 300)],
      );
    },
    async createInvitation(tokenHash, i) {
      await pool.query(
        'INSERT INTO admin_invitations (id, token_hash, organization, roles, created_by_sub, created_by_name, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [i.id, tokenHash, i.organization, i.roles, i.createdBySub, i.createdByName, i.expiresAt],
      );
    },
    async invitations(organization) {
      const { rows } = await pool.query<InvitationRow>(`${INVITATION_COLUMNS} WHERE organization = $1 ORDER BY created_at DESC LIMIT 200`, [organization]);
      return rows.map(fromRow);
    },
    async invitationByHash(tokenHash) {
      const { rows } = await pool.query<InvitationRow>(`${INVITATION_COLUMNS} WHERE token_hash = $1`, [tokenHash]);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async useInvitation(id, sub, at) {
      const { rowCount } = await pool.query(
        'UPDATE admin_invitations SET used_at = $3, used_by_sub = $2 WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $3',
        [id, sub, at],
      );
      return rowCount === 1;
    },
    async revokeInvitation(organization, id, at) {
      const { rowCount } = await pool.query(
        'UPDATE admin_invitations SET revoked_at = $3 WHERE organization = $1 AND id = $2 AND used_at IS NULL AND revoked_at IS NULL',
        [organization, id, at],
      );
      return rowCount === 1;
    },
    async latest(organization, limit) {
      const { rows } = await pool.query<{ organization: string; actor_sub: string; actor_name: string; kind: string; subject: string; at: Date }>(
        'SELECT organization, actor_sub, actor_name, kind, subject, at FROM admin_events WHERE organization = $1 ORDER BY at DESC, id DESC LIMIT $2',
        [organization, limit],
      );
      return rows.map((r) => ({ organization: r.organization, actorSub: r.actor_sub, actorName: r.actor_name, kind: r.kind, subject: r.subject, at: r.at }));
    },
  };
}

/** For tests and for running without a database. */
export function memoryAdminStore(now: () => number = Date.now): AdminStore & {
  sessions: Map<string, AdminSession>; events: AdminEvent[]; invitationsByHash: Map<string, Invitation>;
} {
  const sessions = new Map<string, AdminSession>();
  const events: AdminEvent[] = [];
  const invitations = new Map<string, Invitation>();
  const open = (i: Invitation, at: Date) => !i.usedAt && !i.revokedAt && i.expiresAt > at;
  return {
    sessions,
    events,
    invitationsByHash: invitations,
    async createInvitation(tokenHash, i) {
      invitations.set(tokenHash, { ...i, createdAt: new Date(now()), usedAt: null, usedBySub: null, revokedAt: null });
    },
    async invitations(organization) {
      return [...invitations.values()].filter((i) => i.organization === organization).reverse().map((i) => ({ ...i }));
    },
    async invitationByHash(tokenHash) {
      const i = invitations.get(tokenHash);
      return i ? { ...i } : null;
    },
    async useInvitation(id, sub, at) {
      const i = [...invitations.values()].find((x) => x.id === id);
      if (!i || !open(i, at)) return false;
      i.usedAt = at;
      i.usedBySub = sub;
      return true;
    },
    async revokeInvitation(organization, id, at) {
      const i = [...invitations.values()].find((x) => x.id === id && x.organization === organization);
      if (!i || i.usedAt || i.revokedAt) return false;
      i.revokedAt = at;
      return true;
    },
    async saveSession(idHash, s) { sessions.set(idHash, s); },
    async session(idHash) {
      const s = sessions.get(idHash);
      return s && s.expiresAt.getTime() > now() ? s : null;
    },
    async endSession(idHash) { sessions.delete(idHash); },
    async record(e) { events.push({ ...e, at: new Date(now()) }); },
    async latest(organization, limit) { return events.filter((e) => e.organization === organization).reverse().slice(0, limit); },
  };
}
