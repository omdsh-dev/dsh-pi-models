/**
 * Conversion from pi's `models.json` provider declarations into
 * `@deepseek-ai/dsh-llm-pi-ai` provider profiles.
 *
 * The pi-ai library backs both harnesses, so the conversion is mostly a rename
 * of fields: `baseUrl` becomes `baseURL`, `thinkingLevelMap` becomes
 * `reasoningEfforts`, and the provider dictionary keeps its key. A pi-only
 * concept an LLM route cannot express (a per-model endpoint, a command-sourced
 * key, a compatibility switch the harness withholds) is dropped with a note
 * instead of being smuggled into a field that means something else.
 *
 * This module is pure: files, environment and the installed pi-ai catalog are
 * passed in, so the mapping can be exercised without a running Harness.
 *
 * @module dsh-pi-models/convert
 */

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** pi's documented fallbacks when neither the entry nor the catalog sizes a model. */
const PI_DEFAULT_CONTEXT_WINDOW = 128000
const PI_DEFAULT_MAX_TOKENS = 16384

/**
 * Compatibility switches each supported protocol may configure, taken from the
 * adapter's own offer gates. A pi switch outside its model's set is dropped:
 * the adapter refuses it at configuration time, so passing it through would
 * reject the whole projection.
 */
const COMPAT_FIELDS = {
  'openai-completions': new Set([
    'supportsStore',
    'supportsDeveloperRole',
    'supportsReasoningEffort',
    'supportsUsageInStreaming',
    'supportsFinishReason',
    'maxTokensField',
    'requiresToolResultName',
    'requiresAssistantAfterToolResult',
    'requiresThinkingAsText',
    'requiresReasoningContentOnAssistantMessages',
    'thinkingFormat',
    'chatTemplateKwargs',
    'chatTemplateArgs',
    'supportsThinkingTokenBudget',
    'thinkingTokenBudgetField',
    'vllmPriority',
    'supportsStrictMode',
    'cacheControlFormat',
    'supportsLongCacheRetention',
  ]),
  'openai-responses': new Set([
    'supportsDeveloperRole',
    'supportsMaxOutputTokens',
    'supportsStrictMode',
    'supportsLongCacheRetention',
  ]),
  'anthropic-messages': new Set([
    'supportsEagerToolInputStreaming',
    'supportsLongCacheRetention',
    'supportsCacheControlOnTools',
    'supportsTemperature',
    'forceAdaptiveThinking',
    'allowEmptySignature',
    'supportsStrictTools',
  ]),
}

/** Wire protocols this bridge can pin a route to. */
export const SUPPORTED_APIS = Object.keys(COMPAT_FIELDS)

/** The credential-reference prefix this bridge owns; it also marks managed routes. */
export const MANAGED_REF_PREFIX = 'PI_MODELS_'

/**
 * Whether a configured route carries this bridge's generated credential
 * reference. Used to prune routes pi no longer declares without touching
 * routes a person added through the Models page.
 * @param profile - one configured provider profile.
 * @returns whether this bridge generated the profile's credential reference.
 */
export function isManagedProfile(profile) {
  const ref = profile?.apiKeyEnv
  return typeof ref === 'string' && ref.startsWith(MANAGED_REF_PREFIX) && ref.endsWith('_API_KEY')
}

/**
 * Whether a name is a POSIX shell identifier, the only shape a Harness
 * credential reference accepts.
 * @param name - candidate reference name.
 * @returns whether the name can be stored or resolved as a credential.
 */
export function isCredentialRefName(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/**
 * Build the base credential reference for one pi provider route.
 * @param route - pi provider key.
 * @returns an upper-snake reference name in this bridge's namespace.
 */
export function credentialRefFor(route) {
  const sanitized = String(route)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${MANAGED_REF_PREFIX}${sanitized || 'PROVIDER'}_API_KEY`
}

/** Positive integer or `undefined`. */
function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/** The single distinct non-empty string in `values`, or `undefined`. */
function uniqueValue(values) {
  const seen = new Set()
  for (const value of values) if (typeof value === 'string' && value.length > 0) seen.add(value)
  return seen.size === 1 ? [...seen][0] : undefined
}

/** Non-empty string or `undefined`. */
function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Normalize a declared modality list against the adapter's vocabulary. */
function modalities(input) {
  if (!Array.isArray(input)) return undefined
  const kept = input.filter((value) => value === 'text' || value === 'image')
  return kept.length > 0 ? kept : undefined
}

/** `error.message` without assuming an Error instance. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Classify a pi provider-level API key.
 *
 * pi treats `$NAME` as environment interpolation and `!command` as command
 * output; the Harness stores references, never commands.
 * @param value - the `apiKey` field from pi's models.json.
 * @returns a literal value to store, an environment reference to name
 *   directly, a command marker, or nothing.
 */
function classifyApiKey(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (value.startsWith('$')) {
    const ref = value.slice(1)
    return isCredentialRefName(ref) ? { kind: 'reference', ref } : undefined
  }
  if (value.startsWith('!')) return { kind: 'command', command: value.slice(1) }
  return { kind: 'literal', value }
}

/**
 * Resolve a pi `$NAME` style header value through the host process environment.
 * @param value - a literal, `$NAME`, or `!command` value from pi configuration.
 * @param env - environment lookup.
 * @returns the literal value, or `undefined` when it cannot be resolved here.
 */
function resolvePiValue(value, env) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (value.startsWith('$')) {
    const name = value.slice(1)
    return isCredentialRefName(name) ? env(name) : undefined
  }
  if (value.startsWith('!')) return undefined
  return value
}

/**
 * Turn pi's thinking-level map into the adapter's reasoning-effort dictionary.
 *
 * pi maps each level to the wire value it sends and marks an unsupported level
 * `null`; a level it leaves out keeps the provider default through `high`.
 * The adapter instead lists the offered levels and their wire values, with
 * `off: null` meaning "offered, send nothing".
 * @param map - pi's `thinkingLevelMap`.
 * @returns offered efforts, or `false` when no thinking level is offered.
 */
function effortsFromMap(map) {
  const efforts = {}
  for (const level of LEVELS) {
    if (!(level in map)) {
      if (level === 'off') efforts.off = null
      else if (level !== 'xhigh' && level !== 'max') efforts[level] = level
      continue
    }
    const wire = map[level]
    if (wire === null) continue
    if (typeof wire === 'string' && wire.length > 0) efforts[level] = wire
  }
  return Object.keys(efforts).some((level) => level !== 'off') ? efforts : false
}

/** The level set pi's providers use when a reasoning model declares no map. */
function defaultEfforts() {
  return {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
  }
}

/**
 * Resolve one model's reasoning declaration.
 * @param model - pi's model entry.
 * @param base - the installed catalog model of the same id, when one exists.
 * @returns the adapter's `reasoningEfforts`, or `undefined` to inherit.
 */
function reasoningEfforts(model, base) {
  if (model.reasoning === false) return false
  const reasoning = model.reasoning === true || base?.reasoning === true
  if (!reasoning) return undefined
  const map = model.thinkingLevelMap ?? (base?.thinkingLevelMap && typeof base.thinkingLevelMap === 'object' ? base.thinkingLevelMap : undefined)
  return map ? effortsFromMap(map) : defaultEfforts()
}

/**
 * Keep only the compatibility switches the model's protocol accepts.
 * @param compat - pi's compat block.
 * @param api - the model's wire protocol.
 * @returns the accepted switches, or `undefined` when none remain.
 */
function compatFor(compat, api) {
  if (!compat || typeof compat !== 'object') return undefined
  const offered = COMPAT_FIELDS[api]
  if (!offered) return undefined
  const filtered = {}
  for (const [field, value] of Object.entries(compat)) {
    if (!offered.has(field) || value === undefined) continue
    filtered[field] = value
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined
}

/**
 * Deterministic credential references for a route list, so two provider keys
 * that sanitize to the same name do not overwrite each other.
 * @param routes - pi provider keys in configuration order.
 * @returns route → reference name.
 */
function credentialRefs(routes) {
  const used = new Set()
  const map = new Map()
  for (const route of routes) {
    const base = credentialRefFor(route)
    let candidate = base
    let suffix = 1
    while (used.has(candidate)) {
      suffix += 1
      candidate = base.replace(/_API_KEY$/, `_${suffix}_API_KEY`)
    }
    used.add(candidate)
    map.set(route, candidate)
  }
  return map
}

/**
 * Convert one pi provider declaration into an adapter profile.
 * @param route - pi provider key, also the Harness route.
 * @param provider - pi's provider declaration.
 * @param context - catalog, environment, credential naming and note sink.
 * @returns `{ profile, credentials }` or `{ skip }`.
 */
function convertProvider(route, provider, context) {
  const { catalog, env, auth, options, notes } = context
  const catalogProvider = catalog?.get(route)
  const declared = Array.isArray(provider.models)
    ? provider.models.filter((model) => model && typeof model.id === 'string' && model.id.length > 0)
    : []

  let modelsIn = declared
  if (modelsIn.length === 0) {
    if (!options.includeCatalogModels || !catalogProvider) return { skip: 'declares no models' }
    modelsIn = [...catalogProvider.models.values()]
  }

  const declaredApi = nonEmpty(provider.api)
  const sharedDeclaredApi = uniqueValue(modelsIn.map((model) => model.api))
  const catalogApi = catalogProvider ? uniqueValue([...catalogProvider.models.values()].map((model) => model.api)) : undefined
  const api = declaredApi ?? sharedDeclaredApi ?? catalogApi
  if (!api) return { skip: 'declares no api and no installed catalog entry describes one' }
  if (!SUPPORTED_APIS.includes(api)) return { skip: `uses unsupported api "${api}"` }

  const sharedDeclaredBase = uniqueValue(modelsIn.map((model) => model.baseUrl))
  const baseURL = nonEmpty(provider.baseUrl) ?? sharedDeclaredBase ?? nonEmpty(catalogProvider?.baseUrl)
  if (!baseURL) return { skip: 'declares no baseUrl and no installed catalog entry describes one' }

  const models = []
  for (const model of modelsIn) {
    if (typeof model.api === 'string' && model.api !== api) {
      notes.push({ route, model: model.id, reason: `per-model api "${model.api}" cannot be expressed once a route pins "${api}"` })
      continue
    }
    if (typeof model.baseUrl === 'string' && model.baseUrl !== baseURL) {
      notes.push({ route, model: model.id, reason: 'per-model baseUrl cannot be expressed on one route' })
      continue
    }
    const base = catalogProvider?.models.get(model.id)
    const entry = { id: model.id }
    const name = nonEmpty(model.name) ?? nonEmpty(base?.name)
    if (name) entry.name = name
    entry.contextWindow = positiveInteger(model.contextWindow) ?? positiveInteger(base?.contextWindow) ?? PI_DEFAULT_CONTEXT_WINDOW
    entry.maxTokens = positiveInteger(model.maxTokens) ?? positiveInteger(base?.maxTokens) ?? PI_DEFAULT_MAX_TOKENS
    entry.input = modalities(model.input) ?? modalities(base?.input) ?? ['text']
    const efforts = reasoningEfforts(model, base)
    if (efforts !== undefined) entry.reasoningEfforts = efforts
    const modelCompat = compatFor(model.compat, api)
    if (modelCompat) entry.compat = modelCompat
    models.push(entry)
  }
  if (models.length === 0) return { skip: 'declares no usable models' }

  const profile = {
    displayName: nonEmpty(provider.name) ?? nonEmpty(catalogProvider?.name) ?? route,
    api,
    baseURL,
    models,
  }

  const credentials = []
  const commands = []
  const classified = classifyApiKey(provider.apiKey)
  if (classified?.kind === 'reference') {
    profile.apiKeyEnv = classified.ref
  } else if (classified?.kind === 'command') {
    profile.apiKeyEnv = context.refFor(route)
    commands.push({ ref: profile.apiKeyEnv, command: classified.command, route })
  } else {
    let key = classified?.kind === 'literal' ? classified.value : undefined
    if (key === undefined && auth) {
      const stored = auth[route]
      if (stored?.type === 'api_key' && typeof stored.key === 'string' && stored.key.length > 0) key = stored.key
      else if (stored?.type === 'oauth') notes.push({ route, reason: 'pi holds an OAuth grant for this provider; sign in again from the Models page or configure an API key' })
    }
    if (key !== undefined) {
      profile.apiKeyEnv = context.refFor(route)
      credentials.push({ ref: profile.apiKeyEnv, value: key, route })
    }
  }
  if (provider.oauth !== undefined && profile.apiKeyEnv === undefined) {
    notes.push({ route, reason: `pi declares oauth "${String(provider.oauth)}", which this bridge cannot transfer; sign in from the Models page` })
  }

  const compat = compatFor(provider.compat, api)
  if (compat) profile.compat = compat

  if (provider.headers && typeof provider.headers === 'object') {
    const headers = {}
    for (const [header, raw] of Object.entries(provider.headers)) {
      const value = resolvePiValue(raw, env)
      if (value === undefined) {
        notes.push({ route, reason: `header "${header}" needs a value this bridge cannot resolve` })
        continue
      }
      headers[header] = value
    }
    if (Object.keys(headers).length > 0) profile.headers = headers
  }

  return { profile, credentials, commands }
}

/**
 * Convert a whole pi model configuration.
 * @param input - parsed pi files, the installed catalog, and conversion options.
 * @returns adapter profiles keyed by route, the credentials they need, and
 *   every route or model that could not be projected.
 */
export function convertPiConfig(input) {
  const { models, auth, catalog, options } = input
  const notes = []
  const skipped = []
  const providers = {}
  const credentials = []
  const commands = []

  const routes = Object.keys(models?.providers ?? {})
  const refs = credentialRefs(routes)
  const env = input.env ?? ((name) => process.env[name])

  for (const route of routes) {
    if (options?.include?.length > 0 && !options.include.includes(route)) continue
    if (options?.exclude?.includes(route)) continue
    const provider = models.providers[route]
    if (!provider || typeof provider !== 'object') continue
    let result
    try {
      result = convertProvider(route, provider, {
        catalog,
        auth,
        env,
        options: { includeCatalogModels: options?.includeCatalogModels === true },
        notes,
        refFor: (name) => refs.get(name) ?? credentialRefFor(name),
      })
    } catch (error) {
      result = { skip: `could not be converted: ${messageOf(error)}` }
    }
    if (result.skip) {
      skipped.push({ route, reason: result.skip })
      continue
    }
    providers[route] = result.profile
    for (const credential of result.credentials ?? []) credentials.push(credential)
    for (const command of result.commands ?? []) commands.push(command)
  }

  return { providers, credentials, commands, skipped, notes }
}
