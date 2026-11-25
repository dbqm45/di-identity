import type { AgentView, Person } from './directory.ts';
import type { AdminEvent, AdminSession } from './store.ts';

/**
 * Pages of the admin console: plain HTML from the server, no script (the CSP allows none), forms posting back with the
 * session's form token. Every value from Keycloak or the log is escaped.
 */
export const escape = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `body{margin:0;font:15px/1.45 system-ui,sans-serif;background:#f4f6f9;color:#15202b}
header{display:flex;gap:18px;align-items:baseline;padding:12px 24px;background:#fff;border-bottom:1px solid #dde3ea}
header nav a{margin-right:14px;color:#444;text-decoration:none}header nav a.on{color:#2846b5;font-weight:600}
main{max-width:1100px;margin:0 auto;padding:16px 24px}table{border-collapse:collapse;width:100%;background:#fff}
td,th{border-bottom:1px solid #e5e9ef;padding:8px;text-align:left;vertical-align:top}form.inline{display:inline}
.role{display:inline-block;margin:2px 4px 2px 0;padding:1px 6px;border-radius:4px;background:#eef2ff}
.muted{color:#5b6573}.error{color:#a3261b}button{cursor:pointer}`;

interface PageContext {
  session: AdminSession;
  org: string;
  section: 'people' | 'agents' | 'log';
}

const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${escape(csrf)}">`;

export function page(ctx: PageContext, body: string): string {
  const link = (section: PageContext['section'], label: string) =>
    `<a href="/admin/o/${escape(ctx.org)}/${section}"${section === ctx.section ? ' class="on"' : ''}>${label}</a>`;
  const orgs = ctx.session.organizations.length > 1
    ? ` · ${ctx.session.organizations.map((o) => (o === ctx.org ? `<strong>${escape(o)}</strong>` : `<a href="/admin/o/${escape(o)}/${ctx.section}">${escape(o)}</a>`)).join(' ')}`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Console · ${escape(ctx.org)}</title><style>${STYLE}</style></head><body>
<header><strong>DI Admin Console</strong><span>${escape(ctx.org)}${orgs}</span>
<nav>${link('people', 'People')}${link('agents', 'Agents')}${link('log', 'Change log')}</nav>
<span class="muted">${escape(ctx.session.name)}</span>
<form class="inline" method="post" action="/admin/logout">${csrfField(ctx.session.csrf)}<button type="submit">Sign out</button></form></header>
<main>${body}</main></body></html>`;
}

export function peopleBody(org: string, people: Person[], products: Record<string, string[]>, csrf: string): string {
  const base = `/admin/o/${escape(org)}/people`;
  const options = Object.entries(products).flatMap(([client, roles]) => roles.map((r) => `${client}:${r}`));
  const rows = people.map((p) => {
    const roles = p.roles.map((r) =>
      `<span class="role">${escape(r)} <form class="inline" method="post" action="${base}/${escape(p.id)}/revoke">${csrfField(csrf)}<input type="hidden" name="role" value="${escape(r)}"><button type="submit" title="Take this role away">×</button></form></span>`).join('');
    const grant = `<form class="inline" method="post" action="${base}/${escape(p.id)}/grant">${csrfField(csrf)}<select name="role">${
      options.filter((o) => !p.roles.includes(o)).map((o) => `<option>${escape(o)}</option>`).join('')}</select> <button type="submit">Grant</button></form>`;
    const remove = `<form class="inline" method="post" action="${base}/${escape(p.id)}/remove">${csrfField(csrf)}<button type="submit">Remove from ${escape(org)}</button></form>`;
    return `<tr><td>${escape(p.name)}<br><span class="muted">${escape(p.email)}</span></td><td>${roles || '<span class="muted">no role</span>'}<br>${grant}</td><td>${remove}</td></tr>`;
  });
  return `<h1>People</h1>
<form method="post" action="${base}/add">${csrfField(csrf)}<label>Add a person by e-mail <input type="email" name="email" required></label> <button type="submit">Add</button>
<span class="muted">They must have signed in to the suite once.</span></form>
<table><thead><tr><th>Person</th><th>Product roles</th><th></th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="3" class="muted">No people yet.</td></tr>'}</tbody></table>`;
}

export function agentsBody(org: string, agents: AgentView[], csrf: string): string {
  const base = `/admin/o/${escape(org)}/agents`;
  const rows = agents.map((a) => {
    const action = a.enabled ? 'disable' : 'enable';
    return `<tr><td>${escape(a.clientId)}</td><td>${a.enabled ? 'on' : '<span class="error">off</span>'}</td><td>${escape(a.owner)}</td><td>${escape(a.reviewBy)}</td>
<td><form class="inline" method="post" action="${base}/${escape(a.clientId)}/${action}">${csrfField(csrf)}<button type="submit">${a.enabled ? 'Turn off' : 'Turn on'}</button></form></td></tr>`;
  });
  return `<h1>Agents</h1>
<form method="post" action="${base}/disable-all">${csrfField(csrf)}<button type="submit">Turn off every agent of ${escape(org)}</button>
<span class="muted">New tokens stop at once; issued ones expire within minutes.</span></form>
<table><thead><tr><th>Agent</th><th>State</th><th>Owner</th><th>Review by</th><th></th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="5" class="muted">No agents.</td></tr>'}</tbody></table>`;
}

export function logBody(events: AdminEvent[]): string {
  const rows = events.map((e) => `<tr><td>${escape(e.at?.toISOString().replace('T', ' ').slice(0, 19))}</td><td>${escape(e.actorName)}</td><td>${escape(e.kind)}</td><td>${escape(e.subject)}</td></tr>`);
  return `<h1>Change log</h1><table><thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>About</th></tr></thead><tbody>${
    rows.join('') || '<tr><td colspan="4" class="muted">No changes yet.</td></tr>'}</tbody></table>`;
}

/** A refusal page; `trustedHtml` only for fixed messages written here (never for values from outside). */
export function refusal(message: string, trustedHtml = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Admin Console</title><style>${STYLE}</style></head>
<body><main><h1>DI Admin Console</h1><p class="error">${trustedHtml ? message : escape(message)}</p></main></body></html>`;
}
