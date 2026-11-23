/**
 * A small client of the Keycloak Admin REST API (Keycloak 26). Signs in to the master realm with an administrator
 * account and renews the token before it expires (master tokens live 60 seconds by default). The address is the
 * internal one (e.g. http://keycloak:8080 inside compose): the admin API is never exposed publicly (Caddyfile).
 */
export class AdminError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Admin {
  /** Calls `/admin/realms/<path>`; returns the parsed JSON body, or null for an empty one. */
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** The `id` from the Location header of a create call. */
  create(path: string, body: unknown): Promise<string>;
  readonly url: string;
}

export function keycloakAdmin(input: { url: string; username: string; password: string; fetchImpl?: typeof fetch }): Admin {
  const url = input.url.replace(/\/+$/, '');
  const f = input.fetchImpl ?? fetch;
  let token = '';
  let until = 0;

  const signIn = async (): Promise<string> => {
    if (token && Date.now() < until) return token;
    const res = await f(`${url}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: input.username, password: input.password }),
    });
    if (!res.ok) throw new AdminError(res.status, `Keycloak administrator sign-in failed (HTTP ${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    token = body.access_token;
    until = Date.now() + Math.max(5, body.expires_in - 15) * 1000;
    return token;
  };

  const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await f(`${url}/admin/realms${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${await signIn()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new AdminError(res.status, `${method} ${path}: HTTP ${res.status} ${detail}`);
    }
    return res;
  };

  return {
    url,
    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await send(method, path, body);
      const text = await res.text();
      return (text ? JSON.parse(text) : null) as T;
    },
    async create(path: string, body: unknown): Promise<string> {
      const res = await send('POST', path, body);
      const id = res.headers.get('location')?.split('/').at(-1);
      if (!id) throw new AdminError(500, `POST ${path}: no Location header`);
      return id;
    },
  };
}
