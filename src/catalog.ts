/**
 * Lazy access to the installed pi-ai provider catalog.
 *
 * The catalog answers the two questions pi's own configuration leaves to it: a
 * provider entry that names neither `baseUrl` nor `api` inherits both from the
 * catalog, and a declared model inherits capabilities (context window, output
 * cap, modalities, compatibility switches, thinking levels) from the catalog
 * entry of the same id.
 *
 * The lookup is deliberately tolerant. A workspace bundle is installed as a
 * link to its checkout, so a bare `@earendil-works/pi-ai` specifier resolves
 * from the checkout rather than from the running Harness; the fallback walks
 * the running installation's `node_modules` instead. When neither path finds
 * pi-ai, the bridge still works for providers that spell out `api` and
 * `baseUrl` themselves.
 *
 * @module dsh-pi-models/catalog
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The provider surface this bridge reads off an installed catalog entry. */
export interface PiCatalogProvider {
  id: string
  name?: string
  baseUrl?: string
  models: Map<string, PiCatalogModel>
}

/** The model surface the conversion reads off an installed catalog entry. */
export interface PiCatalogModel {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  contextWindow?: number
  maxTokens?: number
  input?: unknown
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string | null>
  compat?: Record<string, unknown>
}

/** The catalog answer: providers by id, plus the import error when pi-ai is unavailable. */
export interface PiCatalogResult {
  providers: Map<string, PiCatalogProvider>
  error: unknown
}

/** The slice of `@earendil-works/pi-ai`'s providers/all module this bridge probes for. */
interface PiAiCatalogModule {
  builtinProviders?: unknown
  builtinModels?: unknown
}

/** Resolution is attempted once per process generation. */
let pending: Promise<PiCatalogResult> | undefined

/** Candidate `@earendil-works/pi-ai` package directories, nearest last. */
function packageCandidates(): string[] {
  const starts: string[] = []
  if (typeof process.argv[1] === 'string' && process.argv[1].length > 0) {
    // The `dsh` bin is a package-manager symlink; the installation's
    // node_modules sits beside its real path.
    let entry = process.argv[1]
    try {
      entry = realpathSync(entry)
    } catch {
      // Keep the unresolved path; its ancestors are still worth probing.
    }
    starts.push(dirname(entry))
    starts.push(dirname(process.argv[1]))
  }
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)))
  } catch {
    // A non-file module URL simply contributes no candidate.
  }
  const candidates: string[] = []
  for (const start of starts) {
    let directory = start
    for (;;) {
      candidates.push(join(directory, 'node_modules', '@earendil-works', 'pi-ai'))
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return candidates
}

/** The import target of the `./providers/all` export, read from the manifest. */
function providersEntry(directory: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const entry = manifest.exports?.['./providers/all']
    const target = typeof entry === 'string' ? entry : entry?.import ?? entry?.default
    if (typeof target === 'string') return join(directory, target)
  } catch {
    // Fall through to the layout this bridge was written against.
  }
  return join(directory, 'dist', 'providers', 'all.js')
}

/** Import the catalog from the running installation when the bare specifier fails. */
async function importInstalled(): Promise<PiAiCatalogModule | undefined> {
  for (const directory of packageCandidates()) {
    try {
      if (!existsSync(join(directory, 'package.json'))) continue
      const target = providersEntry(directory)
      if (!existsSync(target)) continue
      return await import(pathToFileURL(target).href)
    } catch {
      // Try the next installation candidate.
    }
  }
  return undefined
}

async function readCatalog(): Promise<PiCatalogResult> {
  // The dynamically imported pi-ai module is an external, defensively probed
  // boundary, so its binding stays untyped here.
  let module: any
  try {
    // @ts-ignore — pi-ai is resolved from the running Harness installation, not from this package's dependencies
    module = await import('@earendil-works/pi-ai/providers/all')
  } catch (bareError) {
    try {
      module = await importInstalled()
    } catch {
      module = undefined
    }
    if (module === undefined) return { providers: new Map(), error: bareError }
  }
  const providers = new Map<string, PiCatalogProvider>()
  try {
    const list = typeof module.builtinProviders === 'function'
      ? module.builtinProviders()
      : typeof module.builtinModels === 'function'
        ? module.builtinModels().getProviders()
        : []
    for (const provider of list) {
      if (!provider || typeof provider.id !== 'string' || provider.id.length === 0) continue
      const models = new Map<string, PiCatalogModel>()
      try {
        for (const model of provider.getModels?.() ?? []) if (typeof model?.id === 'string') models.set(model.id, model)
      } catch {
        // One unreadable catalog provider still lets the rest answer endpoint
        // and capability questions.
      }
      providers.set(provider.id, {
        id: provider.id,
        name: typeof provider.name === 'string' ? provider.name : undefined,
        baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : undefined,
        models,
      })
    }
    return { providers, error: undefined }
  } catch (error) {
    return { providers: new Map(), error }
  }
}

/**
 * Read the installed pi-ai catalog once per process generation.
 * @returns provider id → `{ name, baseUrl, models: Map<id, Model> }`, plus the
 *   import error when pi-ai is unavailable.
 */
export function loadPiCatalog(): Promise<PiCatalogResult> {
  pending ??= readCatalog()
  return pending
}
