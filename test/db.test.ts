import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPool } from '../src/db/pool.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { postgresEventStore } from '../src/events/store.ts';
import { postgresAdminStore } from '../src/admin/store.ts';
import { event } from './helpers.ts';

// Runs against a real Postgres when TEST_DATABASE_URL is set (CI sets it); skipped otherwise.
const url = process.env.TEST_DATABASE_URL;

test('migrations apply once and the event store deduplicates by id', { skip: !url && 'TEST_DATABASE_URL is not set' }, async () => {
  const pool = createPool({ databaseUrl: url!, databaseSsl: false });
  try {
    await pool.query('DROP TABLE IF EXISTS received_events, admin_sessions, admin_events, admin_invitations, schema_migrations');
    const [first, second] = await Promise.all([runMigrations(pool), runMigrations(pool)]);
    assert.deepEqual([...first!, ...second!], ['001_received_events.sql', '002_admin_console.sql', '003_admin_invitations.sql']);
    const store = postgresEventStore(pool);
    assert.equal(await store.save(event({ id: 'db-1' }) as never), true);
    assert.equal(await store.save(event({ id: 'db-1' }) as never), false);
    const { rows } = await pool.query('SELECT type, payload FROM received_events');
    assert.deepEqual(rows, [{ type: 'gate.decided', payload: { change: 'CHG-1' } }]);
    // The admin console's store (docs/plan-admin-console.md): sessions by hash, expired ones gone, the log per organization.
    const admin = postgresAdminStore(pool);
    const session = { sub: 's-1', name: 'Adm', organizations: ['acme'], csrf: 'c', expiresAt: new Date(Date.now() + 60_000) };
    await admin.saveSession('h-1', session);
    await admin.saveSession('h-old', { ...session, expiresAt: new Date(Date.now() - 1000) });
    assert.deepEqual(await admin.session('h-1'), session);
    assert.equal(await admin.session('h-old'), null);
    await admin.endSession('h-1');
    assert.equal(await admin.session('h-1'), null);
    await admin.record({ organization: 'acme', actorSub: 's-1', actorName: 'Adm', kind: 'role_granted', subject: 'Ola: di-release:viewer' });
    await admin.record({ organization: 'globex', actorSub: 's-2', actorName: 'Gx', kind: 'person_added', subject: 'X' });
    assert.deepEqual((await admin.latest('acme', 10)).map((e) => [e.kind, e.subject]), [['role_granted', 'Ola: di-release:viewer']]);
    // Invitations by link (docs/plan-admin-console-ac1b.md): by the token's hash, used once, not after revoking or expiry.
    const at = new Date();
    const base = { organization: 'acme', roles: ['di-release:viewer'], createdBySub: 's-1', createdByName: 'Adm', expiresAt: new Date(Date.now() + 60_000) };
    await admin.createInvitation('t-1', { ...base, id: '00000000-0000-4000-8000-000000000001' });
    await admin.createInvitation('t-2', { ...base, id: '00000000-0000-4000-8000-000000000002' });
    await admin.createInvitation('t-3', { ...base, id: '00000000-0000-4000-8000-000000000003', expiresAt: new Date(Date.now() - 1000) });
    const one = await admin.invitationByHash('t-1');
    assert.deepEqual([one?.roles, one?.usedAt], [['di-release:viewer'], null]);
    assert.equal(await admin.useInvitation(one!.id, 'p-1', at), true);
    assert.equal(await admin.useInvitation(one!.id, 'p-2', at), false, 'only once');
    assert.equal((await admin.invitationByHash('t-1'))?.usedBySub, 'p-1');
    assert.equal(await admin.revokeInvitation('globex', '00000000-0000-4000-8000-000000000002', at), false, 'not another organization');
    assert.equal(await admin.revokeInvitation('acme', '00000000-0000-4000-8000-000000000002', at), true);
    assert.equal(await admin.useInvitation('00000000-0000-4000-8000-000000000002', 'p-2', at), false, 'not after revoking');
    assert.equal(await admin.useInvitation('00000000-0000-4000-8000-000000000003', 'p-2', at), false, 'not after expiry');
    assert.equal((await admin.invitations('acme')).length, 3);
    assert.deepEqual(await admin.invitations('globex'), []);
  } finally {
    await pool.end();
  }
});
