/**
 * The daemon's session story — R3's one session, two presentations.
 *
 * @remarks
 * The daemon mints one revocable session token per instance at boot
 * (`<home>/session.token`, 0600): the browser receives it ONLY as an
 * httpOnly cookie (set when the daemon serves the page — a same-origin
 * worker `fetch` carries it with no token in any frame); CLI attachers may
 * present it as a bearer token. Session-tier exposure is acceptable;
 * API-key-tier exposure is not — the inference proxy is the session's first
 * consumer. Revocation is deletion: the file's removal (or the next boot's
 * re-mint) kills every presentation at once.
 *
 * @packageDocumentation
 */

import { join } from 'node:path'

/** The session cookie's name — the browser presentation. */
export const SESSION_COOKIE_NAME = 'behavioral_session'

/** The session token's durable home — read-or-minted at boot, revocable. */
export const sessionTokenPath = (home: string): string => join(home, 'session.token')

/**
 * Read the instance's session token, minting one if absent (first boot, or a
 * revocation). The file never leaves the machine: 0600, under the home.
 */
export const ensureSessionToken = async (home: string): Promise<string> => {
  const path = sessionTokenPath(home)
  const existing = await Bun.file(path)
    .text()
    .catch(() => undefined)
  if (existing !== undefined && existing.trim() !== '') return existing.trim()
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`
  await Bun.write(path, `${token}\n`, { mode: 0o600 })
  return token
}

/** The Set-Cookie value for the browser presentation — httpOnly, same-origin only. */
export const sessionCookie = (token: string): string =>
  `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`

/** The request's `behavioral_session` cookie value, or undefined. */
export const sessionCookieValue = (req: Request): string | undefined => {
  const header = req.headers.get('cookie')
  if (header === null) return undefined
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE_NAME) return rest.join('=')
  }
  return undefined
}

/** The request's `Authorization: Bearer` value, or undefined. */
export const sessionBearerValue = (req: Request): string | undefined => {
  const header = req.headers.get('authorization')
  if (header === null || !header.startsWith('Bearer ')) return undefined
  return header.slice('Bearer '.length)
}

/**
 * Validate one presentation of the session — cookie (the browser) or bearer
 * (the CLI attacher). Either match authenticates; the proxy never accepts an
 * unauthenticated request.
 */
export const validSession = (req: Request, token: string): boolean =>
  sessionCookieValue(req) === token || sessionBearerValue(req) === token
