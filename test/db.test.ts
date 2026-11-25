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
    await pool.query('DROP TABLE IF EXISTS received_events, admin_sessions, admin_events, schema_migrations');
    const [first, second] = await Promise.all([runMigrations(pool), runMigrations(pool)]);
    assert.deepEqual([...first!, ...second!], ['001_received_events.sql', '002_admin_console.sql']);
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
  } finally {
    await pool.end();
  }
});
