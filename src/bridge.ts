/**
 * pi-models — project the models configured for pi into this Harness.
 *
 * pi keeps provider, endpoint, key, capacity and thinking declarations in
 * `~/.pi/agent/models.json`. This Host plugin converts them into
 * `@deepseek-ai/dsh-llm-pi-ai` provider profiles and writes them into that
 * mounted adapter's configuration entry, so the same models appear in the
 * Harness model picker and can be selected per session. pi stays the source of
 * truth: the file is watched, and a change re-projects without a restart.
 *
 * Keys are copied into the Harness credential store under references this
 * plugin owns (`PI_MODELS_<PROVIDER>_API_KEY`); pi's own `$NAME` form is
 * preserved as a reference name so no secret has to move.
 *
 * @module dsh-pi-models
 */

import { execFile } from 'node:child_process'
import { readFileSync, unwatchFile, watchFile } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { PiCatalogResult } from './catalog.js'
import type { CommandKey, ConvertInput, ConvertResult, CredentialWrite } from './convert.js'
import type {
  ApiKeySyncPolicy,
  CredentialService,
  CredentialSummary,
  PiModelsLogger,
  PrunePolicy,
  ProjectContext,
  ProjectionResult,
  ProjectOptions,
  SettingsService,
} from './project.js'

const execFileAsync = promisify(execFile) as (file: string, args: string[], options: { cwd: string, timeout: number, maxBuffer: number, windowsHide: boolean }) => Promise<{ stdout: string, stderr: string }>

/** `commandKeys` policy: run pi's `!command` key sources, or leave their routes keyless. */
export type CommandKeysPolicy = 'execute' | 'skip'

/** Every field this plugin reads, with defaults applied. */
export interface NormalizedConfig {
  piDirectory: string
  modelsFile: string
  authFile: string
  targetEntry: string
  apiKeySync: ApiKeySyncPolicy
  commandKeys: CommandKeysPolicy
  prune: PrunePolicy
  includeCatalogModels: boolean
  include: string[]
  exclude: string[]
  watch: boolean
  pollIntervalMs: number
}

/** One HMR transaction handle, when the Loader's HMR service is mounted. */
interface HmrTransaction {
  getStore?(): unknown
  exit?<T>(operation: () => T): T
}

/** The HMR service slice this bridge consults before writing configuration. */
export interface HmrService {
  executing?: HmrTransaction
}

/** The injected child context this bridge runs its sync loop on. */
export interface InjectChild {
  logger: PiModelsLogger
  llm: { listProviders(): Array<{ id: string }> }
  get(name: 'settings'): SettingsService | undefined
  get(name: 'credentials'): CredentialService | undefined
  get(name: 'hmr'): HmrService | undefined
  effect(teardown: () => () => void, label?: string): unknown
}

/** The cordis plugin context slice this bridge's apply() touches. */
export interface BridgeContext {
  effect(teardown: () => () => void, label?: string): unknown
  inject(services: string[], callback: (child: InjectChild) => void): unknown
}

/** The collaborator modules the entry hands in through its versioned import. */
export interface BridgeModules {
  loadPiCatalog: () => Promise<PiCatalogResult>
  convertPiConfig: (input: ConvertInput) => ConvertResult
  projectProviders: (ctx: ProjectContext, options: ProjectOptions) => Promise<ProjectionResult>
  syncCredentials: (credentials: CredentialService | undefined, entries: CredentialWrite[], policy: ApiKeySyncPolicy, logger: PiModelsLogger) => Promise<CredentialSummary>
}

/** The bridge's mutable runtime state for one mounted row. */
interface BridgeState {
  disposed: boolean
  chain: Promise<void>
  timer: ReturnType<typeof setTimeout> | undefined
  reported: Map<string, string>
}

/** Log a message once per distinct text, so a watched file does not spam. */
type Report = (key: string, level: 'info' | 'warn' | 'debug', message: string) => void

/**
 * Defaults for every field this plugin reads.
 *
 * The entry module ships the Schemastery `Config` the Loader validates
 * against, and its defaults mirror this table; normalizeConfig still applies
 * as the last word inside apply(). Unknown fields are ignored, and a
 * malformed field fails activation with a message naming it.
 */
const DEFAULTS: NormalizedConfig = {
  /** pi agent directory; empty means `$PI_CODING_AGENT_DIR`, then `~/.pi/agent`. */
  piDirectory: '',
  /** Absolute `models.json`; empty means `<piDirectory>/models.json`. */
  modelsFile: '',
  /** Absolute `auth.json`; empty means `<piDirectory>/auth.json`. */
  authFile: '',
  /** Loader entry id of the mounted pi-ai adapter. */
  targetEntry: 'llm-pi-ai',
  /** `always`, `if-missing`, or `never`. */
  apiKeySync: 'always',
  /** `execute` or `skip`. */
  commandKeys: 'execute',
  /** `managed`, `none`, or `all`. */
  prune: 'managed',
  /** Project installed catalog models for a provider that declares none. */
  includeCatalogModels: false,
  /** Only these pi provider keys. */
  include: [],
  /** Never these pi provider keys. */
  exclude: [],
  /** Re-project when the files change. */
  watch: true,
  /** Stat-poll interval for the watched files. */
  pollIntervalMs: 3000,
}

const ENUMS: Record<string, string[]> = {
  apiKeySync: ['always', 'if-missing', 'never'],
  commandKeys: ['execute', 'skip'],
  prune: ['managed', 'none', 'all'],
}

const STRINGS = ['piDirectory', 'modelsFile', 'authFile', 'targetEntry']
const BOOLEANS = ['includeCatalogModels', 'watch']
const LISTS = ['include', 'exclude']

/**
 * Validate and default the row's configuration.
 * @param raw - the `config` object from the Loader entry.
 * @returns every field this plugin reads, with defaults applied.
 * @throws when a field has the wrong shape.
 */
export function normalizeConfig(raw: unknown): NormalizedConfig {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config: NormalizedConfig & Record<string, any> = { ...DEFAULTS }
  for (const [key, value] of Object.entries(source)) if (Object.hasOwn(DEFAULTS, key)) config[key] = value
  for (const key of STRINGS) if (typeof config[key] !== 'string') throw new TypeError(`pi-models: config.${key} must be a string`)
  if (config.targetEntry.length === 0) throw new TypeError('pi-models: config.targetEntry must not be empty')
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (!allowed.includes(config[key])) throw new TypeError(`pi-models: config.${key} must be one of ${allowed.join(', ')}`)
  }
  for (const key of BOOLEANS) if (typeof config[key] !== 'boolean') throw new TypeError(`pi-models: config.${key} must be a boolean`)
  for (const key of LISTS) {
    if (!Array.isArray(config[key]) || config[key].some((value) => typeof value !== 'string')) throw new TypeError(`pi-models: config.${key} must be an array of provider keys`)
  }
  if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs < 250) throw new TypeError('pi-models: config.pollIntervalMs must be a number no smaller than 250')
  return config
}

/**
 * Expand a leading `~` and resolve the path against the process directory.
 * @param path - configured or derived path.
 * @returns an absolute path.
 */
function absolute(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return resolve(path)
}

/**
 * Resolve every file this bridge reads.
 * @param config - the resolved plugin configuration.
 * @returns the pi directory and the two files it may read.
 */
function pathsOf(config: NormalizedConfig) {
  const configured = config.piDirectory.length > 0
    ? config.piDirectory
    : process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
  const directory = absolute(configured)
  return {
    directory,
    models: config.modelsFile.length > 0 ? absolute(config.modelsFile) : join(directory, 'models.json'),
    auth: config.authFile.length > 0 ? absolute(config.authFile) : join(directory, 'auth.json'),
  }
}

/**
 * Read one JSON document, treating "absent" as "not configured yet".
 * @param path - absolute file path.
 * @returns the parsed document, or `undefined` when the file does not exist.
 */
function readJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return undefined
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Run one pi `!command` key source and return its trimmed output.
 * @param command - the shell text after pi's `!` marker.
 * @returns the key the command printed.
 */
async function runKeyCommand(command: string): Promise<string> {
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
  const { stdout } = await execFileAsync(shell, args, {
    cwd: homedir(),
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  })
  return stdout.trim()
}

/**
 * Resolve command-sourced keys, one failure never blocking the other routes.
 * @param commands - `{ route, ref, command }` entries from the conversion.
 * @param policy - `execute` runs them; `skip` leaves their routes keyless.
 * @param report - de-duplicated logger.
 * @returns credential writes for the commands that produced a value.
 */
async function resolveCommandKeys(commands: CommandKey[], policy: CommandKeysPolicy, report: Report): Promise<CredentialWrite[]> {
  if (policy === 'skip') {
    for (const entry of commands) {
      report(`command-skip:${entry.route}`, 'warn', `pi-models: provider "${entry.route}" keeps its key in a command; commandKeys is "skip", so set that key from the Models page if you need the route`)
    }
    return []
  }
  const settled = await Promise.all(commands.map(async (entry) => {
    try {
      const value = await runKeyCommand(entry.command)
      if (value.length === 0) throw new Error('the command printed nothing')
      return { ref: entry.ref, route: entry.route, value }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      report(`command:${entry.route}:${detail}`, 'warn', `pi-models: the key command for provider "${entry.route}" failed (${detail}); that route stays keyless until it succeeds`)
      return undefined
    }
  }))
  return settled.filter((entry) => entry !== undefined)
}

/**
 * Install the bridge on one context.
 * The entry module imports this file with a version query, so a reloaded row
 * runs the implementation currently on disk. Its collaborators therefore
 * arrive as arguments instead of static imports, which would stay cached.
 * @param ctx - the plugin context.
 * @param rawConfig - the row's `config` object.
 * @param modules - `{ loadPiCatalog, convertPiConfig, projectProviders, syncCredentials }`.
 */
export function apply(ctx: BridgeContext, rawConfig: unknown, modules: BridgeModules): void {
  const config = normalizeConfig(rawConfig)
  const state: BridgeState = {
    disposed: false,
    chain: Promise.resolve(),
    timer: undefined,
    reported: new Map(),
  }
  const paths = pathsOf(config)

  ctx.effect(() => () => {
    state.disposed = true
    if (state.timer !== undefined) clearTimeout(state.timer)
  }, 'pi-models.lifecycle')

  // The projection writes into another plugin's live configuration, so it runs
  // only while the settings service can accept it and restarts with it.
  ctx.inject(['settings'], (child) => {
    const logger = child.logger

    /** Log a message once per distinct text, so a watched file does not spam. */
    const report: Report = (key, level, message) => {
      if (state.reported.get(key) === message) return
      // Keys embed error details, which can vary without bound; cap the map
      // so a long-lived Host plugin does not grow it forever. Clearing loses
      // some de-duplication but never correctness.
      if (state.reported.size >= 256) state.reported.clear()
      state.reported.set(key, message)
      logger[level](message)
    }

    const sync = async (reason: string): Promise<void> => {
      if (state.disposed) return
      const models = readJson(paths.models)
      if (models === undefined) {
        report('missing', 'info', `pi-models: no pi models file at ${paths.models}; waiting for it`)
        return
      }
      if (!models || typeof models !== 'object' || !models.providers || typeof models.providers !== 'object' || Array.isArray(models.providers)) {
        report('shape', 'warn', `pi-models: ${paths.models} has no "providers" object; nothing to project`)
        return
      }
      const auth = readJson(paths.auth) ?? {}
      const catalog = await modules.loadPiCatalog()
      if (state.disposed) return
      if (catalog.error) {
        report('catalog', 'warn', `pi-models: the installed pi-ai catalog is unavailable (${catalog.error instanceof Error ? catalog.error.message : String(catalog.error)}); providers must declare api and baseUrl themselves`)
      }
      const converted = modules.convertPiConfig({
        models,
        auth,
        catalog: catalog.providers,
        options: {
          includeCatalogModels: config.includeCatalogModels,
          include: config.include,
          exclude: config.exclude,
        },
      })

      for (const skip of converted.skipped) report(`skip:${skip.route}`, 'warn', `pi-models: skipping provider "${skip.route}": ${skip.reason}`)
      for (const note of converted.notes.slice(0, 20)) {
        const where = note.model ? `provider "${note.route}" model "${note.model}"` : `provider "${note.route}"`
        report(`note:${note.route}:${note.model ?? ''}:${note.reason}`, 'debug', `pi-models: ${where}: ${note.reason}`)
      }

      const commandCredentials = await resolveCommandKeys(converted.commands, config.commandKeys, report)
      if (state.disposed) return
      const credentialSummary = await modules.syncCredentials(
        child.get('credentials'),
        [...converted.credentials, ...commandCredentials],
        config.apiKeySync,
        logger,
      )
      if (state.disposed) return

      const projection = await modules.projectProviders(child, { profiles: converted.providers, config, logger })
      if (state.disposed) return

      for (const blocked of projection.blocked) {
        report(`blocked:${blocked.route}`, 'warn', `pi-models: not projecting provider "${blocked.route}": ${blocked.reason}`)
      }
      const modelCount = projection.models
      const routeCount = projection.routes
      const pruned = projection.pruned.length > 0 ? `, dropped ${projection.pruned.join(', ')}` : ''
      const stored = credentialSummary.synced > 0 ? `, stored ${credentialSummary.synced} key(s)` : ''
      if (projection.changed) {
        logger.info(`pi-models: projected ${routeCount} provider(s) / ${modelCount} model(s) from ${paths.models}${stored}${pruned} (${reason})`)
      } else {
        logger.debug(`pi-models: ${routeCount} provider(s) / ${modelCount} model(s) already projected (${reason})`)
      }
    }

    /**
     * The Loader mounts this plugin inside an HMR transaction, and every timer
     * or watcher created here inherits that async context. A configuration
     * write refuses to open a nested transaction, so the sync is run outside
     * the inherited context; the HMR queue then serializes it normally.
     * @param operation - the sync to run.
     * @returns the operation's result.
     */
    const outsideTransaction = <T>(operation: () => T): T => {
      const executing = child.get('hmr')?.executing
      const nested = typeof executing?.getStore === 'function' && executing.getStore() !== undefined
      return nested && typeof executing.exit === 'function' ? executing.exit(operation) : operation()
    }

    const enqueue = (reason: string): void => {
      state.chain = state.chain.then(() => outsideTransaction(() => sync(reason))).catch((error) => {
        report(`error:${reason}`, 'warn', `pi-models: sync failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    const schedule = (reason: string): void => {
      if (state.disposed) return
      if (state.timer !== undefined) clearTimeout(state.timer)
      state.timer = setTimeout(() => {
        state.timer = undefined
        enqueue(reason)
      }, 150)
      if (typeof state.timer.unref === 'function') state.timer.unref()
    }

    if (config.watch) {
      child.effect(() => {
        const listener = () => schedule('file change')
        for (const file of [paths.models, paths.auth]) {
          watchFile(file, { interval: config.pollIntervalMs, persistent: false }, listener)
        }
        return () => {
          for (const file of [paths.models, paths.auth]) unwatchFile(file, listener)
        }
      }, 'pi-models.watch')
    }

    schedule('startup')
  })
}
