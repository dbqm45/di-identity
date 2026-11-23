import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Admin } from './admin.ts';
import type { SuiteConfig } from './configure.ts';

/**
 * The client secrets Keycloak generated for the suite's product clients, written into an env file so the applications
 * (and `sdlc up` in pdi) read them from there instead of someone copying each one from the admin console.
 *
 * One variable per client, `SUITE_CLIENT_SECRET_<CLIENT ID>` (e.g. SUITE_CLIENT_SECRET_DI_CHANNELS). The file is merged,
 * not replaced: these lines are set, every other line stays as it was. It is written with mode 0600 and atomically
 * (a temporary file renamed over it). The values are never printed.
 */
export const secretVariable = (clientId: string): string => `SUITE_CLIENT_SECRET_${clientId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

export async function clientSecrets(admin: Admin, suite: SuiteConfig): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const c of suite.clients) {
    const found = await admin.call<{ id: string }[]>('GET', `/${suite.realm}/clients?clientId=${encodeURIComponent(c.clientId)}`);
    const id = found[0]?.id;
    if (!id) throw new Error(`client ${c.clientId} does not exist in realm ${suite.realm}: run configure first`);
    const secret = await admin.call<{ value?: string }>('GET', `/${suite.realm}/clients/${id}/client-secret`);
    if (!secret?.value) throw new Error(`client ${c.clientId} has no secret`);
    out.set(secretVariable(c.clientId), secret.value);
  }
  return out;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** `text` with each variable in `values` set (replaced where it is, otherwise appended); other lines untouched. */
export function mergeEnv(text: string, values: ReadonlyMap<string, string>): string {
  const left = new Map(values);
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const merged = lines.map((line) => {
    const name = LINE.exec(line)?.[1];
    if (!name || !left.has(name)) return line;
    const value = left.get(name)!;
    left.delete(name);
    return `${name}=${value}`;
  });
  if (left.size) merged.push('# Client secrets of the suite realm (npm run identity -- secrets)', ...[...left].map(([k, v]) => `${k}=${v}`));
  return `${merged.join('\n')}\n`;
}

export function writeEnvFile(path: string, values: ReadonlyMap<string, string>): void {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, mergeEnv(before, values), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
