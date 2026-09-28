/**
 * The shell faculty's default threads — the ICL thread libraries that
 * ship with the faculty ("threads arrive with the worker they drive"):
 *
 * - `skill-scan` boot + catalog transform (schema-gated) — the skills
 *   catalog store tenant;
 * - `plugin-scan` boot + manifests transform (schema-gated) — the plugins
 *   manifest tenant;
 * - `links` seeder + the two dispatchers — the contract recipes
 *   (extract-links / validate-links) as store values plus their
 *   links_request → shell_request wiring.
 *
 * Composed contents of the former src/threads/{skill-client,
 * plugin-client, skill-links}.ts, moved wholesale when the threads became
 * faculty-shipped. The threads require the shell faculty (its executor) and
 * the store faculty (its tenants) — bProgram mounts it only when both
 * are on.
 *
 * @packageDocumentation
 */

import type { Thread } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The logical scan name — the shell_request trace label (the run op routes through the shell worker). */
export const SKILL_SCAN_TOOL = 'skill-scan'

/** The boot scan call's correlation id — the catalog transform matches on it via the store value. */
export const SKILL_SCAN_CALL_ID = 'skill-scan-catalog'

/** The store collection holding the skills catalog. */
export const SKILL_CATALOG_COLLECTION = 'skills'

/** The catalog's store key — one value, the whole catalog (v1). */
export const SKILL_CATALOG_KEY = 'catalog'

// ── The catalog schema — schema-data: one shape, three uses (thread gate,
// store admission, future model-facing context) ──────────────────────────────

/** A validated catalog record — one skill's tier-1 metadata. */
export const SKILL_CATALOG_RECORD_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    location: { type: 'string', minLength: 1 },
  },
  required: ['name', 'description', 'location'],
  // Frontmatter is open — extra fields ride along verbatim.
  additionalProperties: true,
} as const

/**
 * The recipe→store contract: the coarse catalog envelope, enforced by the
 * catalog transform's detailSchema BEFORE the put — validate-before-put as a
 * hard gate. A malformed catalog fails the whole put (fail-closed), never
 * partial admission. Strictness is scoped to `jsonData`; the surrounding
 * ShellResult fields stay loose (their schema home is the shell faculty).
 */
export const SKILL_CATALOG_SCHEMA = {
  type: 'object',
  properties: {
    skills: { type: 'array', items: SKILL_CATALOG_RECORD_SCHEMA },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['skills', 'warnings'],
  additionalProperties: false,
} as const

// ── The scan recipe (stored-recipe flavor: contract-pinned, replayed verbatim) ─

/**
 * The skill-scan recipe — executed bun-direct by the shell worker's `run` op (script on stdin).
 *
 * For each SKILL.md: read the file → slice the `---` frontmatter fence →
 * `YAML.parse` the slice ONLY (never the whole file). Lenient per-skill
 * validation mirrors the retired tool: skip + warn on unparseable YAML,
 * missing or empty name/description; warn but load on name/dir mismatch
 * and name length. User scope scans first, then project — project wins on
 * collision (same precedence as the tool). Output is one JSON object on
 * stdout: `{ skills: [...], warnings: [...] }`, sorted by name.
 */
export const SKILL_SCAN_SCRIPT = `
import { readdirSync } from 'node:fs'
import { YAML } from 'bun'

const SKILL_DIR_NAME = '.agents/skills'
const SKILL_FILE = 'SKILL.md'
const SKIP_DIRS = new Set(['.git', 'node_modules'])
const NAME_MAX_LENGTH = 64

const skills = new Map()
const warnings = []

const parseFrontmatter = (markdown) => {
  const match = markdown.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---/)
  if (!match) return null
  try {
    const parsed = YAML.parse(match[1])
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

const scanRoot = async (skillsRoot, scope, skills, warnings) => {
  let entries
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
    const skillFile = skillsRoot + '/' + entry.name + '/' + SKILL_FILE
    const file = Bun.file(skillFile)
    if (!(await file.exists())) continue
    const markdown = await file.text()
    const frontmatter = parseFrontmatter(markdown)
    if (frontmatter === null) {
      warnings.push('Skipped skill "' + entry.name + '" at ' + skillFile + ': unparseable YAML frontmatter')
      continue
    }
    const name = frontmatter.name
    const description = frontmatter.description
    if (typeof name !== 'string' || name.length === 0) {
      warnings.push('Skipped skill at ' + skillFile + ': missing or empty name')
      continue
    }
    if (typeof description !== 'string' || description.trim().length === 0) {
      warnings.push('Skipped skill "' + name + '" at ' + skillFile + ': missing or empty description')
      continue
    }
    if (name !== entry.name) {
      warnings.push('Skill "' + name + '" at ' + skillFile + ': name does not match parent directory "' + entry.name + '"')
    }
    if (name.length > NAME_MAX_LENGTH) {
      warnings.push('Skill "' + name + '" at ' + skillFile + ': name exceeds ' + NAME_MAX_LENGTH + ' characters')
    }
    const existing = skills.get(name)
    if (existing !== undefined && existing.scope === 'user' && scope === 'project') {
      warnings.push('Skill "' + name + '": project-level overrides user-level')
    }
    const rest = {}
    for (const key of Object.keys(frontmatter)) {
      if (key !== 'name' && key !== 'description') rest[key] = frontmatter[key]
    }
    skills.set(name, { record: { name, description, location: skillFile, ...rest }, scope })
  }
}

const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
await scanRoot(home + '/' + SKILL_DIR_NAME, 'user', skills, warnings)
await scanRoot(process.cwd() + '/' + SKILL_DIR_NAME, 'project', skills, warnings)

const sorted = [...skills.values()].map((s) => s.record).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
console.log(JSON.stringify({ skills: sorted, warnings }))
`

// ── Threads ───────────────────────────────────────────────────────────────────

/** scan-boot — once: the scan recipe is requested at boot; the tools worker pipes it. */
const skillScanBoot: Thread = {
  label: 'skill/scan-boot',
  once: true,
  rules: [
    {
      request: {
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: {
          id: SKILL_SCAN_CALL_ID,
          label: SKILL_SCAN_TOOL,
          input: { op: 'run', script: SKILL_SCAN_SCRIPT, format: 'json' },
        },
      },
    },
  ],
}

/** catalog — a scan result carrying a skills catalog is put into the store as one value. */
const skillCatalog: Thread = {
  label: 'skill/catalog',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query:
            '. as $d | select($d.result.jsonData.skills? != null) | {id: $d.id, op: "put", input: {collection: "skills", key: "catalog", value: $d.result.jsonData}}',
          target: FACULTY_MESSAGE_KINDS.store_request,
          // The validate-before-put gate: the envelope schema nests under
          // jsonData — strict at the payload, loose around it (absent
          // jsonData passes and the query rejects instead).
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              result: {
                type: 'object',
                properties: { jsonData: SKILL_CATALOG_SCHEMA },
                required: ['jsonData'],
                additionalProperties: true,
              },
            },
            required: ['id', 'result'],
          },
        },
      ],
    },
  ],
}

/** The skill-client thread library — add to the program alongside the satellites. */
export const skillThreads: Thread[] = [skillScanBoot, skillCatalog]

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The logical scan name — the shell_request trace label (the run op routes through the shell worker). */
export const PLUGIN_SCAN_TOOL = 'plugin-scan'

/** The boot scan call's correlation id. */
export const PLUGIN_SCAN_CALL_ID = 'plugin-scan-manifests'

/** The store collection holding the plugin manifests. */
export const PLUGIN_MANIFESTS_COLLECTION = 'plugins'

/** The manifests' store key — one value, the whole manifest set (v1). */
export const PLUGIN_MANIFESTS_KEY = 'manifests'

// ── The manifest schemas — schema-data: one shape, three uses (thread gate,
// store admission / governor consumption, future model-facing context) ───────

/** A normalized plugin manifest — the governor's admission input. */
export const PLUGIN_MANIFEST_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    version: { type: 'string' },
    mcps: {
      type: 'object',
      // Per-server configs are loose here — their strict shape was validated
      // by the recipe (§7.2.1); the wire payload stays payloads-loose.
      additionalProperties: true,
    },
    skills: { type: 'array', items: { type: 'string' } },
    threads: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'mcps', 'skills', 'threads', 'warnings'],
  additionalProperties: false,
} as const

/**
 * The recipe→store contract: the coarse manifest-set envelope, enforced by
 * the manifests transform's detailSchema BEFORE the put — validate-before-put
 * as a hard gate (fail-closed, never partial admission). Strictness is scoped
 * to `jsonData`; the surrounding ShellResult fields stay loose (their schema
 * home is the shell faculty).
 */
export const PLUGIN_MANIFESTS_SCHEMA = {
  type: 'object',
  properties: {
    plugins: { type: 'array', items: PLUGIN_MANIFEST_SCHEMA },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['plugins', 'warnings'],
  additionalProperties: false,
} as const

// ── The manifest-scan recipe (stored-recipe flavor: contract-pinned,
//    replayed verbatim — the §11.3 posture is zero-variance logic) ───────────

/**
 * The plugin-scan recipe — executed bun-direct by the shell worker's `run` op (script on stdin).
 *
 * Scans `<cwd>/.agents/plugins/` (project) and `<HOME>/.agents/plugins/`
 * (user); for each plugin dir: read + parse plugin.json → fatal validation
 * (a fatal plugin is skipped with a scan-level warning, others load) →
 * mcp.json two-stage validation with failure isolation → skills/ +
 * `sh.behavioral/threads/` discovery (the reverse-domain namespace dir,
 * agent-plugins §8.2 — behavioral-specific threads are a client extension).
 * Output is one JSON object on stdout:
 * `{ plugins: [manifest…], warnings: [scan-level…] }`, sorted by name.
 */
export const PLUGIN_SCAN_SCRIPT = `
import { readdirSync } from 'node:fs'
import * as path from 'node:path'

const PLUGIN_DIR_NAME = '.agents/plugins'
const PLUGIN_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const NAME_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/
const NAME_NO_DOUBLE = /(--|\\.\\.)/
const KNOWN_FIELDS = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'])
const AUTHOR_FIELDS = new Set(['name', 'email', 'url'])
const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd'])
const HTTP_FIELDS = new Set(['type', 'url', 'headers'])
const PLUGIN_ROOT_TOKEN = '$' + '{PLUGIN_ROOT}'
const PLUGIN_DATA_TOKEN = '$' + '{PLUGIN_DATA}'

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

const msg = (err) => (err instanceof Error ? err.message : String(err))

const validateName = (name) =>
  typeof name === 'string' &&
  name.length >= 1 &&
  name.length <= 64 &&
  NAME_PATTERN.test(name) &&
  !NAME_NO_DOUBLE.test(name)

const schemaVersion = (url) => {
  const m = url.match(/\\/schemas\\/([^/]+)\\//)
  return m === null ? null : m[1]
}

// §7.2.1: a single executable token — a bare name or a ./-prefixed path.
const isValidStdioCommand = (command) => {
  if (command.startsWith('/') || /\\s/.test(command)) return false
  if (command.startsWith('./')) return true
  return !command.includes('/')
}

const isLoopbackHost = (hostname) => {
  if (hostname === 'localhost') return true
  if (/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(hostname)) return Number(hostname.split('.')[0]) === 127
  return hostname === '::1' || hostname === '[::1]'
}

// RFC 7230 token characters.
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_|~0-9A-Za-z-]+$/

const isValidHeaderSet = (headers) => {
  const seen = new Set()
  for (const name of Object.keys(headers)) {
    if (!HEADER_NAME_PATTERN.test(name)) return false
    const lower = name.toLowerCase()
    if (seen.has(lower)) return false
    seen.add(lower)
  }
  return true
}

// §7.2.1: absolute http(s), no userinfo/fragment, https unless loopback.
const isValidHttpUrl = (rawUrl) => {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.hash !== '') return false
  if (url.protocol === 'https:') return true
  return isLoopbackHost(url.hostname)
}

// §7.2.1: ./-prefixed or token-rooted, staying within the plugin root.
const isValidStdioCwd = (cwd) => {
  if (cwd === PLUGIN_DATA_TOKEN || cwd.startsWith(PLUGIN_DATA_TOKEN + '/')) return true
  let relativeToRoot = null
  if (cwd === PLUGIN_ROOT_TOKEN) relativeToRoot = '.'
  else if (cwd.startsWith(PLUGIN_ROOT_TOKEN + '/')) relativeToRoot = cwd.slice(PLUGIN_ROOT_TOKEN.length + 1)
  else if (cwd.startsWith('./')) relativeToRoot = cwd.slice(2)
  else return false
  return relativeToRoot.split('/').every((segment) => segment !== '..')
}

const validStdioEntry = (entry) => {
  if (!isPlainObject(entry)) return false
  if (!Object.keys(entry).every((k) => STDIO_FIELDS.has(k))) return false
  if (entry.type !== 'stdio') return false
  if (typeof entry.command !== 'string' || entry.command.length === 0) return false
  if (entry.args !== undefined && !(Array.isArray(entry.args) && entry.args.every((a) => typeof a === 'string'))) return false
  if (entry.env !== undefined && !(isPlainObject(entry.env) && Object.values(entry.env).every((v) => typeof v === 'string'))) return false
  if (entry.cwd !== undefined && typeof entry.cwd !== 'string') return false
  return true
}

const validHttpEntry = (entry) => {
  if (!isPlainObject(entry)) return false
  if (!Object.keys(entry).every((k) => HTTP_FIELDS.has(k))) return false
  if (entry.type !== 'streamable-http' && entry.type !== 'sse') return false
  if (typeof entry.url !== 'string' || entry.url.length === 0) return false
  if (entry.headers !== undefined && !(isPlainObject(entry.headers) && Object.values(entry.headers).every((v) => typeof v === 'string'))) return false
  return true
}

const validMcpTop = (parsed) =>
  isPlainObject(parsed) &&
  typeof parsed.$schema === 'string' &&
  isPlainObject(parsed.mcpServers) &&
  Object.keys(parsed).every((k) => k === '$schema' || k === 'mcpServers')

// Fatal plugin.json validation — same posture as the tool (§5.2/§5.5).
const validatePluginJson = (parsed) => {
  if (!isPlainObject(parsed)) return { isError: true, message: 'plugin.json must be a JSON object' }
  if (parsed.$schema !== PLUGIN_SCHEMA_URL) {
    return { isError: true, message: 'plugin.json $schema must be ' + PLUGIN_SCHEMA_URL }
  }
  if (!('name' in parsed)) {
    return { isError: true, message: 'plugin.json missing required field: name' }
  }
  if (!validateName(parsed.name)) {
    return { isError: true, message: 'plugin.json name "' + String(parsed.name) + '" violates naming constraints' }
  }
  if ('version' in parsed && typeof parsed.version !== 'string') {
    return { isError: true, message: 'plugin.json version must be a string' }
  }
  if ('description' in parsed && typeof parsed.description !== 'string') {
    return { isError: true, message: 'plugin.json description must be a string' }
  }
  if ('homepage' in parsed && typeof parsed.homepage !== 'string') {
    return { isError: true, message: 'plugin.json homepage must be a string' }
  }
  if ('repository' in parsed && typeof parsed.repository !== 'string') {
    return { isError: true, message: 'plugin.json repository must be a string' }
  }
  if ('license' in parsed && typeof parsed.license !== 'string') {
    return { isError: true, message: 'plugin.json license must be a string' }
  }
  if ('keywords' in parsed && !(Array.isArray(parsed.keywords) && parsed.keywords.every((k) => typeof k === 'string'))) {
    return { isError: true, message: 'plugin.json keywords must be an array of strings' }
  }
  if ('author' in parsed) {
    const author = parsed.author
    if (!isPlainObject(author) || !Object.keys(author).every((k) => AUTHOR_FIELDS.has(k)) || !Object.values(author).every((v) => typeof v === 'string')) {
      return { isError: true, message: 'plugin.json author must be an object with optional name, email, url string fields' }
    }
  }
  if ('extensions' in parsed && !isPlainObject(parsed.extensions)) {
    return { isError: true, message: 'plugin.json extensions must be an object' }
  }
  return {
    name: parsed.name,
    version: parsed.version,
    unknownFields: Object.keys(parsed).filter((key) => !KNOWN_FIELDS.has(key)),
  }
}

const loadMcpJson = async (mcpPath, pluginSchemaVersion, warnings) => {
  const file = Bun.file(mcpPath)
  if (!(await file.exists())) return {}

  let text
  try {
    text = await file.text()
  } catch {
    warnings.push('mcp.json could not be read; MCP disabled')
    return {}
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    warnings.push('mcp.json is not valid JSON; MCP disabled')
    return {}
  }

  if (!validMcpTop(parsed)) {
    warnings.push('mcp.json failed top-level validation; MCP disabled')
    return {}
  }

  const mcpVersion = schemaVersion(parsed.$schema)
  if (mcpVersion !== pluginSchemaVersion) {
    warnings.push('mcp.json $schema version (' + String(mcpVersion) + ') does not match plugin.json (' + String(pluginSchemaVersion) + '); MCP disabled')
    return {}
  }

  // Per-entry validation with failure isolation — a bad entry is skipped,
  // siblings still load.
  const result = {}
  for (const name of Object.keys(parsed.mcpServers)) {
    const entry = parsed.mcpServers[name]
    if (validStdioEntry(entry)) {
      if (!isValidStdioCommand(entry.command)) {
        warnings.push('mcp server "' + name + '" skipped: command must be a single executable token (bare name or ./-prefixed)')
        continue
      }
      if (entry.cwd !== undefined && !isValidStdioCwd(entry.cwd)) {
        warnings.push('mcp server "' + name + '" skipped: cwd must be ./-prefixed or ' + PLUGIN_ROOT_TOKEN + '/' + PLUGIN_DATA_TOKEN + '-rooted and stay within the plugin root')
        continue
      }
      result[name] = entry
    } else if (validHttpEntry(entry)) {
      if (!isValidHttpUrl(entry.url)) {
        warnings.push('mcp server "' + name + '" skipped: url must be absolute http(s), without userinfo/fragment, https for non-loopback hosts')
        continue
      }
      if (entry.headers !== undefined && !isValidHeaderSet(entry.headers)) {
        warnings.push('mcp server "' + name + '" skipped: header names must be valid HTTP tokens without case-insensitive duplicates')
        continue
      }
      result[name] = entry
    } else {
      warnings.push('mcp server "' + name + '" skipped: invalid server entry')
    }
  }
  return result
}

const discoverSkills = async (skillsDir) => {
  try {
    const entries = await Array.fromAsync(new Bun.Glob('*/SKILL.md').scan({ cwd: skillsDir, onlyFiles: true }))
    return entries.map((e) => e.split('/')[0])
  } catch {
    return []
  }
}

const discoverThreads = async (threadsDir) => {
  try {
    const allFiles = await Array.fromAsync(new Bun.Glob('*').scan({ cwd: threadsDir, onlyFiles: true }))
    return allFiles.sort()
  } catch {
    return []
  }
}

// One plugin: manifest on success, a skip message on fatal, null when the
// directory is not a plugin (no plugin.json — skipped silently).
const scanPlugin = async (pluginJsonPath) => {
  const pluginRoot = path.dirname(pluginJsonPath)
  const file = Bun.file(pluginJsonPath)
  if (!(await file.exists())) return null
  let text
  try {
    text = await file.text()
  } catch (err) {
    return { skip: 'Could not read plugin.json: ' + msg(err) }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { skip: 'Invalid JSON in plugin.json: ' + msg(err) }
  }
  const pluginResult = validatePluginJson(parsed)
  if (pluginResult.isError === true) return { skip: pluginResult.message }

  const warnings = []
  if (pluginResult.unknownFields.length > 0) {
    warnings.push('plugin.json: ignoring unknown top-level field(s): ' + pluginResult.unknownFields.join(', '))
  }
  const mcps = await loadMcpJson(path.join(pluginRoot, 'mcp.json'), schemaVersion(PLUGIN_SCHEMA_URL), warnings)
  const skills = await discoverSkills(path.join(pluginRoot, 'skills'))
  const threads = await discoverThreads(path.join(pluginRoot, 'sh.behavioral/threads'))
  const manifest = { name: pluginResult.name, mcps, skills, threads, warnings }
  if (pluginResult.version !== undefined) manifest.version = pluginResult.version
  return { manifest }
}

const scanRoot = async (pluginsRoot, manifests, warnings) => {
  let entries
  try {
    entries = readdirSync(pluginsRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue
    const result = await scanPlugin(pluginsRoot + '/' + entry.name + '/plugin.json')
    if (result === null) continue
    if (result.skip !== undefined) {
      warnings.push('Skipped plugin at ' + pluginsRoot + '/' + entry.name + ': ' + result.skip)
      continue
    }
    manifests.push(result.manifest)
  }
}

const manifests = []
const warnings = []
const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
await scanRoot(home + '/' + PLUGIN_DIR_NAME, manifests, warnings)
await scanRoot(process.cwd() + '/' + PLUGIN_DIR_NAME, manifests, warnings)

manifests.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
console.log(JSON.stringify({ plugins: manifests, warnings }))
`

// ── Threads ───────────────────────────────────────────────────────────────────

/** scan-boot — once: the manifest-scan recipe is requested at boot; the shell worker runs it. */
const pluginScanBoot: Thread = {
  label: 'plugin/scan-boot',
  once: true,
  rules: [
    {
      request: {
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: {
          id: PLUGIN_SCAN_CALL_ID,
          label: PLUGIN_SCAN_TOOL,
          input: { op: 'run', script: PLUGIN_SCAN_SCRIPT, format: 'json' },
        },
      },
    },
  ],
}

/** manifests — a scan result carrying plugin manifests is put into the store as one value. */
const pluginManifests: Thread = {
  label: 'plugin/manifests',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query:
            '. as $d | select($d.result.jsonData.plugins? != null) | {id: $d.id, op: "put", input: {collection: "plugins", key: "manifests", value: $d.result.jsonData}}',
          target: FACULTY_MESSAGE_KINDS.store_request,
          // The validate-before-put gate: the envelope schema nests under
          // jsonData — strict at the payload, loose around it (absent
          // jsonData passes and the query rejects instead).
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              result: {
                type: 'object',
                properties: { jsonData: PLUGIN_MANIFESTS_SCHEMA },
                required: ['jsonData'],
                additionalProperties: true,
              },
            },
            required: ['id', 'result'],
          },
        },
      ],
    },
  ],
}

/** The plugin-client thread library — add to the program alongside the satellites. */
export const pluginThreads: Thread[] = [pluginScanBoot, pluginManifests]

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Model-facing request event: one recipe call, one correlation id. */
export const LINKS_EVENT_TYPES = { request: 'links_request' } as const

/** The store collection holding skill recipes (the literal recipe home). */
export const LINKS_RECIPES_COLLECTION = 'skill-recipes'

/** The extract-links recipe's store key. */
export const LINKS_EXTRACT_RECIPE_KEY = 'extract-links'

/** The validate-links recipe's store key. */
export const LINKS_VALIDATE_RECIPE_KEY = 'validate-links'

/** The logical recipe names — the shell_request trace labels. */
export const SKILL_EXTRACT_LINKS_TOOL = 'skill-extract-links'
export const SKILL_VALIDATE_LINKS_TOOL = 'skill-validate-links'

// ── Shared parser core (transcribed verbatim from the retired tool) ─────────

/** Escape-aware link parsing + collection + normalization — shared by both recipes. */
const PARSER_CORE = `
import * as path from 'node:path'

const normalizeMarkdownLink = (value) => {
  if (
    !value ||
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('mailto:') ||
    value.startsWith('#')
  ) {
    return null
  }
  const linkPath = value.split('#')[0]
  if (!linkPath) return null
  return path.normalize(linkPath)
}

const extractMarkdownLinkDestination = (value) => {
  const trimmedValue = value.trim()
  if (!trimmedValue) return trimmedValue
  if (trimmedValue.startsWith('<')) {
    const closingBracketIndex = trimmedValue.indexOf('>')
    if (closingBracketIndex > 0) return trimmedValue.slice(1, closingBracketIndex)
  }
  const firstWhitespaceIndex = trimmedValue.search(/\\s/)
  if (firstWhitespaceIndex === -1) return trimmedValue
  return trimmedValue.slice(0, firstWhitespaceIndex)
}

const stripHtmlTags = (value) => {
  const textParts = []
  let pendingTag = null
  for (const character of value) {
    if (pendingTag) {
      pendingTag.push(character)
      if (character === '>') pendingTag = null
      continue
    }
    if (character === '<') {
      pendingTag = ['<']
      continue
    }
    textParts.push(character)
  }
  if (pendingTag) textParts.push(...pendingTag)
  return textParts.join('')
}

const isEscapedCharacter = (value, index) => {
  let slashCount = 0
  for (let currentIndex = index - 1; currentIndex >= 0 && value[currentIndex] === '\\\\'; currentIndex -= 1) {
    slashCount += 1
  }
  return slashCount % 2 === 1
}

const findInlineDestinationEnd = (value, startIndex) => {
  for (let index = startIndex; index < value.length; index += 1) {
    const character = value[index]
    if (character === '\\n' || character === '\\r') return -1
    if (value[index] !== ')' || isEscapedCharacter(value, index)) continue
    return index
  }
  return -1
}

const extractInlineMarkdownLinks = (markdownBody) => {
  const links = []
  for (let index = 0; index < markdownBody.length; index += 1) {
    const character = markdownBody[index]
    if (character === undefined) continue
    const startsImageLink = character === '!' && markdownBody[index + 1] === '[' && !isEscapedCharacter(markdownBody, index)
    const startsTextLink = character === '[' && !isEscapedCharacter(markdownBody, index)
    if (!startsImageLink && !startsTextLink) continue
    const openBracketIndex = startsImageLink ? index + 1 : index
    let scanIndex = openBracketIndex + 1
    let bracketDepth = 1
    let closeBracketIndex = -1
    while (scanIndex < markdownBody.length) {
      const scanCharacter = markdownBody[scanIndex]
      if (scanCharacter === undefined) break
      if (scanCharacter === '[' && !isEscapedCharacter(markdownBody, scanIndex)) bracketDepth += 1
      else if (scanCharacter === ']' && !isEscapedCharacter(markdownBody, scanIndex)) {
        bracketDepth -= 1
        if (bracketDepth === 0) {
          closeBracketIndex = scanIndex
          break
        }
      }
      scanIndex += 1
    }
    if (closeBracketIndex === -1) {
      index = openBracketIndex
      continue
    }
    const openParenIndex = closeBracketIndex + 1
    if (markdownBody[openParenIndex] !== '(') {
      index = closeBracketIndex
      continue
    }
    const destinationStartIndex = openParenIndex + 1
    const destinationEndIndex = findInlineDestinationEnd(markdownBody, destinationStartIndex)
    if (destinationEndIndex === -1) {
      index = openParenIndex
      continue
    }
    const destination = markdownBody.slice(destinationStartIndex, destinationEndIndex)
    if (destination.trim().length > 0) {
      links.push({ text: markdownBody.slice(openBracketIndex + 1, closeBracketIndex), destination })
    }
    index = destinationEndIndex
  }
  return links
}

const extractLocalLinksFromMarkdown = async (markdownBody) => {
  const links = new Set()
  const html = Bun.markdown.html(markdownBody)
  const rewriter = new HTMLRewriter()
  const linkTextByTarget = new Map()
  const setText = (target, text) => {
    if (!target || linkTextByTarget.has(target)) return
    linkTextByTarget.set(target, text.trim() || target)
  }
  for (const link of extractInlineMarkdownLinks(markdownBody)) {
    setText(normalizeMarkdownLink(extractMarkdownLinkDestination(link.destination)), link.text)
  }
  const htmlAnchorPattern = /<a\\b[^>]*\\bhref=(['"])(.*?)\\1[^>]*>([\\s\\S]*?)<\\/a>/gi
  for (const match of markdownBody.matchAll(htmlAnchorPattern)) {
    setText(normalizeMarkdownLink(match[2] ?? ''), stripHtmlTags(match[3] ?? ''))
  }
  const htmlImagePattern = /<img\\b[^>]*>/gi
  for (const match of markdownBody.matchAll(htmlImagePattern)) {
    const imageTag = match[0] ?? ''
    const sourceMatch = imageTag.match(/\\bsrc=(['"])(.*?)\\1/i)
    const altMatch = imageTag.match(/\\balt=(['"])(.*?)\\1/i)
    setText(sourceMatch ? normalizeMarkdownLink(sourceMatch[2] ?? '') : null, altMatch?.[2] ?? '')
  }
  for (const selector of ['a', 'img']) {
    rewriter.on(selector, {
      element(element) {
        const attribute = selector === 'a' ? 'href' : 'src'
        const value = element.getAttribute(attribute)
        const normalizedLink = value === null ? null : normalizeMarkdownLink(value)
        if (normalizedLink) links.add(normalizedLink)
      },
    })
  }
  const rewritten = rewriter.transform(html)
  if (typeof rewritten === 'string') void rewritten
  else if (rewritten instanceof Response || rewritten instanceof Blob) await rewritten.text()
  else await new Response(rewritten).text()
  return [...links].sort().map((value) => ({ value, text: linkTextByTarget.get(value) ?? value }))
}
`

// ── The extract-links recipe ─────────────────────────────────────────────────

/** Extract sorted, de-duplicated local links from env-carried markdown — the recipe verbatim. */
export const SKILL_EXTRACT_LINKS_SCRIPT = `
${PARSER_CORE}
const input = process.env.LINKS_INPUT ?? ''
const links = await extractLocalLinksFromMarkdown(input)
console.log(JSON.stringify({ links }))
`

// ── The validate-links recipe ────────────────────────────────────────────────

/** Resolve env-carried markdown's local links against cwd, present/missing — the recipe verbatim. */
export const SKILL_VALIDATE_LINKS_SCRIPT = `
${PARSER_CORE}
const input = process.env.LINKS_INPUT ?? ''
const rootRelative = process.env.LINKS_ROOT_RELATIVE === '1'
const links = await extractLocalLinksFromMarkdown(input)
const present = []
const missing = []
for (const link of links) {
  const linkPath = rootRelative && link.value.startsWith('/') ? link.value.slice(1) : link.value
  const absolutePath = path.resolve(process.cwd(), linkPath)
  if (await Bun.file(absolutePath).exists()) {
    present.push({ value: link.value, text: link.text || link.value })
  } else {
    missing.push({ value: link.value, text: link.text || link.value })
  }
}
const byValueThenText = (left, right) =>
  left.value.localeCompare(right.value) || left.text.localeCompare(right.text)
present.sort(byValueThenText)
missing.sort(byValueThenText)
console.log(JSON.stringify({ present, missing }))
`

// ── Threads ───────────────────────────────────────────────────────────────────

/** seeder — boot (once): both recipes filed in the store; the recipe home exists. */
const linksSeeder: Thread = {
  label: 'skill-links/seeder',
  once: true,
  rules: [
    {
      request: {
        type: FACULTY_MESSAGE_KINDS.store_request,
        detail: {
          id: 'seed-extract-links',
          op: 'put',
          input: {
            collection: LINKS_RECIPES_COLLECTION,
            key: LINKS_EXTRACT_RECIPE_KEY,
            value: SKILL_EXTRACT_LINKS_SCRIPT,
          },
        },
      },
    },
    {
      request: {
        type: FACULTY_MESSAGE_KINDS.store_request,
        detail: {
          id: 'seed-validate-links',
          op: 'put',
          input: {
            collection: LINKS_RECIPES_COLLECTION,
            key: LINKS_VALIDATE_RECIPE_KEY,
            value: SKILL_VALIDATE_LINKS_SCRIPT,
          },
        },
      },
    },
  ],
}

/** The links_request detail schema — shared by both dispatchers. */
const LINKS_REQUEST_DETAIL_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    recipe: { type: 'string', minLength: 1 },
    input: { type: 'object' },
  },
  required: ['id', 'recipe', 'input'],
} as const

/** dispatcher-extract — links_request becomes the extract shell_request; recipe static, markdown via env. */
const dispatcherExtract: Thread = {
  label: 'skill-links/dispatch-extract',
  rules: [
    {
      transform: [
        {
          type: LINKS_EVENT_TYPES.request,
          query: `. as $d | select($d.recipe == "${LINKS_EXTRACT_RECIPE_KEY}") | {id: $d.id, label: "${SKILL_EXTRACT_LINKS_TOOL}", input: {op: "run", script: ${JSON.stringify(SKILL_EXTRACT_LINKS_SCRIPT)}, format: "json", env: {LINKS_INPUT: $d.input.markdown}}}`,
          target: FACULTY_MESSAGE_KINDS.shell_request,
          detailSchema: LINKS_REQUEST_DETAIL_SCHEMA,
        },
      ],
    },
  ],
}

/** dispatcher-validate — links_request becomes the validate shell_request; rootRelative rides env too. */
const dispatcherValidate: Thread = {
  label: 'skill-links/dispatch-validate',
  rules: [
    {
      transform: [
        {
          type: LINKS_EVENT_TYPES.request,
          query: `. as $d | select($d.recipe == "${LINKS_VALIDATE_RECIPE_KEY}") | {id: $d.id, label: "${SKILL_VALIDATE_LINKS_TOOL}", input: {op: "run", script: ${JSON.stringify(SKILL_VALIDATE_LINKS_SCRIPT)}, format: "json", env: {LINKS_INPUT: $d.input.markdown, LINKS_ROOT_RELATIVE: (if ($d.input.rootRelative // false) then "1" else "0" end)}}}`,
          target: FACULTY_MESSAGE_KINDS.shell_request,
          detailSchema: LINKS_REQUEST_DETAIL_SCHEMA,
        },
      ],
    },
  ],
}

/** The skill-links thread library — add to the program alongside the satellites. */
export const skillLinksThreads: Thread[] = [linksSeeder, dispatcherExtract, dispatcherValidate]

// ── The faculty threads ───────────────────────────────────────────────────────────

/** The shell faculty's default threads — scans, catalog/manifest gates, links. */
export const shellThreads: Thread[] = [...skillThreads, ...pluginThreads, ...skillLinksThreads]
