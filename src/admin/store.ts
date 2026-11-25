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

export interface AdminStore {
  saveSession(idHash: string, session: AdminSession): Promise<void>;
  session(idHash: string): Promise<AdminSession | null>;
  endSession(idHash: string): Promise<void>;
  record(event: AdminEvent): Promise<void>;
  /** The organization's latest events, newest first. */
  latest(organization: string, limit: number): Promise<AdminEvent[]>;
}

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
export function memoryAdminStore(now: () => number = Date.now): AdminStore & { sessions: Map<string, AdminSession>; events: AdminEvent[] } {
  const sessions = new Map<string, AdminSession>();
  const events: AdminEvent[] = [];
  return {
    sessions,
    events,
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
