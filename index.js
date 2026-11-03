/**
 * pi-models — project the models configured for pi into this Harness.
 *
 * The entry module stays deliberately thin. A workspace bundle is installed as
 * a link to its checkout, so this file is imported once per Harness process;
 * the implementation is imported through a URL carrying the implementation's
 * modification time instead. Reloading the row (or reinstalling it) therefore
 * runs the code currently on disk, without a server restart, and the four
 * collaborator modules are fetched with the same version so edits to any of
 * them take effect too.
 *
 * @module dsh-pi-models
 */

import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import schema from '@deepseek-ai/schemastery'

export const name = 'pi-models'

/** The LLM registry is the one service this bridge cannot work without. */
export const inject = ['llm']

/**
 * Loader-visible configuration schema. The defaults mirror the DEFAULTS table
 * in src/bridge.js so the Loader, the profile's validation, and the runtime
 * all agree. The bridge's own normalizeConfig still applies as the last word
 * inside apply().
 *
 * @returns the Schemastery object schema for this plugin's configuration.
 */
export const Config = schema.object({
  piDirectory: schema.string().default(''),
  modelsFile: schema.string().default(''),
  authFile: schema.string().default(''),
  targetEntry: schema.string().default('llm-pi-ai'),
  apiKeySync: schema.union(['always', 'if-missing', 'never']).default('always'),
  commandKeys: schema.union(['execute', 'skip']).default('execute'),
  prune: schema.union(['managed', 'none', 'all']).default('managed'),
  includeCatalogModels: schema.boolean().default(false),
  include: schema.array(schema.string()).default([]),
  exclude: schema.array(schema.string()).default([]),
  watch: schema.boolean().default(true),
  pollIntervalMs: schema.number().default(3000),
})

/**
 * The implementation generation: the newest modification time among the files
 * that make up the bridge.
 * @returns an opaque version string.
 */
function implementationVersion() {
  const files = ['./src/bridge.js', './src/convert.js', './src/catalog.js', './src/project.js']
  let newest = 0
  for (const file of files) {
    try {
      newest = Math.max(newest, statSync(fileURLToPath(new URL(file, import.meta.url))).mtimeMs)
    } catch {
      // A missing file is left to the import below to report.
    }
  }
  return String(newest)
}

/**
 * Install the bridge from the current on-disk implementation.
 * @param ctx - the plugin context.
 * @param config - the row's `config` object.
 */
export async function apply(ctx, config) {
  const version = implementationVersion()
  const [bridge, convert, catalog, projection] = await Promise.all([
    import(`./src/bridge.js?v=${version}`),
    import(`./src/convert.js?v=${version}`),
    import(`./src/catalog.js?v=${version}`),
    import(`./src/project.js?v=${version}`),
  ])
  return bridge.apply(ctx, config, {
    loadPiCatalog: catalog.loadPiCatalog,
    convertPiConfig: convert.convertPiConfig,
    projectProviders: projection.projectProviders,
    syncCredentials: projection.syncCredentials,
  })
}
