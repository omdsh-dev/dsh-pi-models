/**
 * Projection of converted pi provider profiles into the live Harness.
 *
 * The Harness keeps model routes in the configuration of the
 * `@deepseek-ai/dsh-llm-pi-ai` entry, so this module writes there rather than
 * registering a second adapter of its own: the mounted adapter then owns route
 * registration, the Models page, retries and discovery exactly as it does for
 * hand-written profiles. Keys follow the same split the adapter documents —
 * configuration names a credential reference and the value lives in the
 * credential store.
 *
 * Writes are whole-dictionary and revision-checked, and are skipped when the
 * projected value is already in place, so a restart with an unchanged
 * `models.json` does not touch the profile document.
 *
 * @module dsh-pi-models/project
 */

/**
 * Whether a configured route carries this bridge's generated credential
 * reference. Kept here as well as in the conversion so this module stays
 * import-free for the entry's versioned import.
 *
 * The `PI_MODELS_` prefix and `_API_KEY` suffix duplicate
 * `MANAGED_REF_PREFIX` in convert.js; change both files together.
 * @param profile - one configured provider profile.
 * @returns whether this bridge generated the profile's credential reference.
 */
function isManagedProfile(profile) {
  const ref = profile?.apiKeyEnv
  return typeof ref === 'string' && ref.startsWith('PI_MODELS_') && ref.endsWith('_API_KEY')
}

/** Stable JSON rendering, so key order alone never counts as a change. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * Bring the credential store in line with pi's literal keys.
 * @param credentials - the credential service, when the composition mounts one.
 * @param entries - `{ ref, value, route }` writes from the conversion.
 * @param policy - `always` rewrites a differing value, `if-missing` fills only
 *   an unset reference, `never` leaves the store alone.
 * @param logger - sink for per-reference failures.
 * @returns counts of written and already-matching references.
 */
export async function syncCredentials(credentials, entries, policy, logger) {
  const summary = { synced: 0, unchanged: 0, failed: 0 }
  if (policy === 'never') return summary
  if (credentials === undefined) {
    if (entries.length > 0) logger.warn('pi-models: no credentials service is mounted, so pi API keys cannot be stored; routes will report MISSING_CREDENTIAL')
    return summary
  }
  for (const entry of entries) {
    try {
      if (policy === 'if-missing') {
        const current = await credentials.resolve(entry.ref)
        if (typeof current?.value === 'string' && current.value.length > 0) {
          summary.unchanged += 1
          continue
        }
      } else {
        const current = await credentials.resolve(entry.ref)
        if (current?.value === entry.value) {
          summary.unchanged += 1
          continue
        }
      }
      await credentials.set(entry.ref, entry.value)
      summary.synced += 1
    } catch (error) {
      summary.failed += 1
      logger.warn(`pi-models: could not store the key for route "${entry.route}" as ${entry.ref}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return summary
}

/**
 * Build the provider dictionary to persist.
 * @param current - providers configured today.
 * @param profiles - projected providers from pi.
 * @param policy - `managed` prunes routes carrying this bridge's credential
 *   reference, `all` prunes everything pi does not declare, `none` keeps
 *   every configured route.
 * @returns the next dictionary and the routes it dropped.
 */
export function buildProviders(current, profiles, policy) {
  const pruned = []
  const next = policy === 'all' ? {} : { ...current }
  for (const [route, profile] of Object.entries(profiles)) next[route] = profile
  if (policy === 'none') return { providers: next, pruned }
  for (const [route, profile] of Object.entries(current)) {
    if (Object.hasOwn(profiles, route)) continue
    if (policy === 'managed' && !isManagedProfile(profile)) continue
    delete next[route]
    pruned.push(route)
  }
  return { providers: next, pruned }
}

/** The `providers` dictionary of one settings section. */
function providersOf(section) {
  if (!section || typeof section !== 'object' || Array.isArray(section)) return {}
  const providers = section.providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return {}
  return providers
}

/** Describe the target entry, or explain why it cannot be configured. */
function describeTarget(settings, targetEntry) {
  const rows = settings.describe()
  // Loader entry ids carry their include path (`include:llm-pi-ai`), while the
  // patch row — the name a person writes — is the bare id. Accept both.
  const descriptor = rows.find((row) => row.ns === targetEntry)
    ?? rows.find((row) => typeof row.ns === 'string' && row.ns.endsWith(`:${targetEntry}`))
  if (descriptor === undefined) {
    const available = rows.map((row) => row.ns).join(', ')
    throw new Error(`pi-models: no configurable entry "${targetEntry}" is active; mount @deepseek-ai/dsh-llm-pi-ai (the "llm-pi-ai" row) or point targetEntry at its entry id. Configurable entries: ${available || 'none'}`)
  }
  return descriptor
}

/**
 * A configuration write can land while the Loader is replacing modules (a
 * profile reload, a bundle toggle, a plugin installation). The HMR service
 * refuses to open a transaction inside that one, so the write waits for it to
 * close instead of failing the whole projection.
 */
const HMR_BUSY = 'HMR transactions cannot be nested'

/** Backoff for writes that arrive during a Loader transaction. */
const HMR_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000]

/**
 * Run one settings write, retrying only while the HMR queue is occupied.
 * @param operation - the write to attempt.
 * @param logger - sink for the eventual failure.
 * @returns the write's result.
 */
async function withHmrRetry(operation, logger) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const busy = error instanceof Error && error.message.includes(HMR_BUSY)
      if (!busy || attempt >= HMR_RETRY_DELAYS_MS.length) throw error
      const delay = HMR_RETRY_DELAYS_MS[attempt]
      logger.debug(`pi-models: the profile is reloading; retrying the projection write in ${delay}ms`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

/**
 * Persist the projected providers into the mounted pi-ai adapter's entry.
 * @param ctx - a context carrying `llm` and (optionally) `settings`.
 * @param options - projected profiles, config and logging.
 * @returns what changed.
 */
export async function projectProviders(ctx, options) {
  const { profiles, config, logger } = options
  const settings = ctx.get('settings')
  if (settings === undefined) {
    throw new Error('pi-models: this composition mounts no settings service, so the pi-ai entry cannot be configured; mount @deepseek-ai/dsh-settings and @deepseek-ai/dsh-config-editor')
  }

  const apply = async (attempt) => {
    const descriptor = describeTarget(settings, config.targetEntry)
    // Compare and build from the profile's own override, not the effective
    // value: the latter carries schema defaults, so comparing against it would
    // rewrite the document on every sync. Routes from lower layers stay
    // effective without being pinned into this override.
    const current = providersOf(descriptor.user)
    // A route the target adapter already serves is not a collision: rewriting
    // its entry is how the projection updates it.
    const taken = new Set(ctx.llm.listProviders().map((provider) => provider.id))
    const blocked = []
    const projected = {}
    for (const [route, profile] of Object.entries(profiles)) {
      if (taken.has(route) && !Object.hasOwn(current, route)) {
        blocked.push({ route, reason: 'another adapter already serves this route' })
        continue
      }
      projected[route] = profile
    }
    const { providers, pruned } = buildProviders(current, projected, config.prune)
    const models = Object.values(projected).reduce((total, profile) => total + profile.models.length, 0)
    if (stableJson(providers) === stableJson(current)) {
      return { changed: false, routes: Object.keys(projected).length, models, pruned: [], blocked, revision: descriptor.revision }
    }
    try {
      await settings.replace(descriptor.ns, { providers }, descriptor.revision)
    } catch (error) {
      if (attempt === 0 && error instanceof Error && error.name === 'SettingsConflictError') return apply(1)
      throw error
    }
    return { changed: true, routes: Object.keys(projected).length, models, pruned, blocked, revision: descriptor.revision }
  }

  return withHmrRetry(() => apply(0), logger)
}
