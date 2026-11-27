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
  /** Posts a multipart form (e.g. `identity-provider/import-config` with a metadata file); returns the parsed JSON. */
  form<T = unknown>(path: string, form: FormData): Promise<T>;
  readonly url: string;
}

export function keycloakAdmin(input: { url: string; username: string; password: string; fetchImpl?: typeof fetch }): Admin {
  return adminClient(input.url, input.fetchImpl, 'master', { grant_type: 'password', client_id: 'admin-cli', username: input.username, password: input.password });
}

/**
 * The same Admin REST API with the service account of the di-identity client in the suite realm (client
 * credentials): the running service reads users with only the realm-management roles `configure` gives that account
 * (view-users, query-users), never with the master administrator.
 */
export function keycloakServiceAdmin(input: { url: string; realm: string; clientId: string; clientSecret: string; fetchImpl?: typeof fetch }): Admin {
  return adminClient(input.url, input.fetchImpl, input.realm, { grant_type: 'client_credentials', client_id: input.clientId, client_secret: input.clientSecret });
}

function adminClient(rawUrl: string, fetchImpl: typeof fetch | undefined, realm: string, form: Record<string, string>): Admin {
  const url = rawUrl.replace(/\/+$/, '');
  const f = fetchImpl ?? fetch;
  let token = '';
  let until = 0;

  const signIn = async (): Promise<string> => {
    if (token && Date.now() < until) return token;
    const res = await f(`${url}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams(form),
    });
    if (!res.ok) throw new AdminError(res.status, `Keycloak sign-in for the admin API failed (HTTP ${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    token = body.access_token;
    until = Date.now() + Math.max(5, body.expires_in - 15) * 1000;
    return token;
  };

  const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const multipart = body instanceof FormData;
    const res = await f(`${url}/admin/realms${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${await signIn()}`, ...(body === undefined || multipart ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
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
    async form<T>(path: string, form: FormData): Promise<T> {
      const res = await send('POST', path, form);
      return (await res.json()) as T;
    },
    async create(path: string, body: unknown): Promise<string> {
      const res = await send('POST', path, body);
      const id = res.headers.get('location')?.split('/').at(-1);
      if (!id) throw new AdminError(500, `POST ${path}: no Location header`);
      return id;
    },
  };
}
