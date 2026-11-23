import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { mergeEnv, secretVariable, writeEnvFile } from '../src/keycloak/secrets.ts';

describe('client secrets into an env file', () => {
  it('names one variable per client', () => {
    assert.equal(secretVariable('di-channels'), 'SUITE_CLIENT_SECRET_DI_CHANNELS');
    assert.equal(secretVariable('di-release-control'), 'SUITE_CLIENT_SECRET_DI_RELEASE_CONTROL');
  });

  it('replaces the variables where they are, appends the missing ones, keeps every other line', () => {
    const before = '# mine\nPORT=3200\nSUITE_CLIENT_SECRET_DI_CHANNELS=old\nexport SUITE_CLIENT_SECRET_DI_ADMIN=old2\n\nOTHER=x';
    const after = mergeEnv(before, new Map([['SUITE_CLIENT_SECRET_DI_CHANNELS', 'new'], ['SUITE_CLIENT_SECRET_DI_ADMIN', 'new2'], ['SUITE_CLIENT_SECRET_DI_IDENTITY', 'id']]));
    assert.equal(
      after,
      '# mine\nPORT=3200\nSUITE_CLIENT_SECRET_DI_CHANNELS=new\nSUITE_CLIENT_SECRET_DI_ADMIN=new2\n\nOTHER=x\n# Client secrets of the suite realm (npm run identity -- secrets)\nSUITE_CLIENT_SECRET_DI_IDENTITY=id\n',
    );
    assert.equal(mergeEnv(after, new Map([['SUITE_CLIENT_SECRET_DI_IDENTITY', 'id']])), after);
  });

  it('writes a new or existing file with mode 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-'));
    const fresh = join(dir, 'new.env');
    writeEnvFile(fresh, new Map([['SUITE_CLIENT_SECRET_DI_IDENTITY', 's']]));
    assert.match(readFileSync(fresh, 'utf8'), /^# Client secrets.*\nSUITE_CLIENT_SECRET_DI_IDENTITY=s\n$/);
    const old = join(dir, 'old.env');
    writeFileSync(old, 'PORT=3200\n', { mode: 0o644 });
    writeEnvFile(old, new Map([['SUITE_CLIENT_SECRET_DI_IDENTITY', 's']]));
    assert.match(readFileSync(old, 'utf8'), /^PORT=3200\n/);
    for (const f of [fresh, old]) assert.equal(statSync(f).mode & 0o777, 0o600);
  });
});
