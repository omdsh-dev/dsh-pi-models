# dsh-pi-models

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
> · Oh My DSH ([omdsh-dev](https://github.com/omdsh-dev)) community project.

Use the models you already configured for [pi](https://pi.dev) in DeepSeek
Harness. The plugin reads pi's `models.json`, converts each provider into a
`@deepseek-ai/dsh-llm-pi-ai` profile, and writes the projection into that
adapter's live configuration entry, so the models appear in the Harness model
picker with their own provider names, endpoints, keys, context windows and
thinking levels.

pi stays the source of truth. The file is watched: add, remove, or retune a
model in `~/.pi/agent/models.json` and the Harness projection follows without a
restart. An unchanged file projects to an identical dictionary, so a normal
startup does not rewrite the profile's configuration.

## What it maps

| pi (`models.json`) | Harness (`llm-pi-ai` profile) |
| --- | --- |
| `providers.<name>.name` | `displayName` |
| `providers.<name>.baseUrl` | `baseURL` |
| `providers.<name>.api` | `api` (only `openai-completions`, `openai-responses`, `anthropic-messages`) |
| `providers.<name>.apiKey` | `apiKeyEnv` — literal keys are stored in the credential store under `PI_MODELS_<PROVIDER>_API_KEY`; a pi `$NAME` value keeps `NAME` as the reference; a pi `!command` value is run once per sync and stored the same way |
| pi `auth.json` API key | same as `apiKey`, when the provider entry has none |
| `providers.<name>.headers` | `headers` (`$NAME` values resolve from the process environment; `!command` values are not run and the header is dropped with a note) |
| `providers.<name>.compat` | `compat` (withheld switches dropped) |
| `models[].id`, `name` | model id, display name |
| `models[].contextWindow`, `maxTokens`, `input` | the same fields |
| `models[].thinkingLevelMap` | `reasoningEfforts` (`null` levels are not offered) |
| `models[].compat` | model `compat` |

A provider that names neither `api` nor `baseUrl` inherits both from the
installed pi-ai catalog (for example `zai-coding-cn`), and declared models
inherit capabilities from the catalog entry of the same id.

## What it deliberately does not do

- A per-model `api` or `baseUrl` cannot be expressed on one Harness route; such
  a model is skipped with a log line instead of being silently misrouted.
- `!command` header values are not run. A `!command` API key is run only when
  `commandKeys: execute`, and its output is stored in the Harness credential
  store; set `commandKeys: skip` to keep such secrets out of that store.
- pi OAuth grants are not copied; sign in again from the Harness Models page or
  configure an API key for that provider.
- Only models pi's `models.json` declares are projected. Set
  `includeCatalogModels` to also project a provider's installed pi-ai catalog
  when its entry declares no models.

## Configuration

All fields are ordinary configuration, editable in the profile's
`cordis.patch.yml` under the `pi-models` row:

```yaml
- id: pi-models
  name: dsh-pi-models
  config:
    piDirectory: ~/.pi/agent      # default: $PI_CODING_AGENT_DIR, then ~/.pi/agent
    targetEntry: llm-pi-ai        # loader entry id of the mounted pi-ai adapter
    apiKeySync: always            # always | if-missing | never
    commandKeys: execute          # execute | skip
    prune: managed                # managed | none | all
    includeCatalogModels: false
    include: []
    exclude: []
    watch: true
    pollIntervalMs: 3000
```

`prune: managed` removes a configured route only when pi no longer declares it
**and** the route carries this bridge's `PI_MODELS_*_API_KEY` reference, so
routes you added by hand through the Models page are left alone. `all` makes
the projection an exact mirror of pi; `none` never removes anything.

Unknown fields are ignored and a malformed field fails activation with a
message naming it. The example row's `name` is inserted by the bundle; a config
override needs only `- id: pi-models` and the fields you change.

## Where the projection lives

The projection is written into the mounted `@deepseek-ai/dsh-llm-pi-ai` entry
(entry id `llm-pi-ai` by default), which is the same place the Models page
edits. That entry's `providers` dictionary is therefore a projection of
`models.json` for every route pi declares: editing those routes in the Models
page is allowed, but the next sync of `models.json` replaces them. Routes for
providers pi does not declare are preserved. Removing this plugin leaves the
last projection in place, still usable and editable.

## Reloading during development

The entry module loads `src/*.js` through a URL carrying the implementation's
modification time, so reloading the `pi-models` row (or reinstalling the
bundle) runs the code currently on disk. Only a change to `index.js` itself
needs a Harness restart; `config: { watch: true }` already re-projects on
`models.json` changes without any reload.

## Failure and recovery

- A provider whose conversion fails is skipped and logged; the rest of the
  projection still applies.
- A route already served by another adapter is left alone and logged.
- If the whole configuration write is refused by the adapter (for example an
  endpoint the protocol cannot serve), the profile document is left unchanged
  and the error is logged; repair the pi entry and the next file change retries.

## Install

This plugin is distributed as a GitHub Release tarball (no npm build step).
From the profile directory, install the latest release tag, or fetch the pack
and install it locally:

```sh
# from the profile that will host the bundle
dsh plugin --profile <profile> add "https://github.com/omdsh-dev/dsh-pi-models/releases/download/v0.1.0/pkg.tgz"
```

or unpack `dist/pkg.tgz` from a release and point `dsh plugin add` at the
directory. Then enable the `pi-models` row in the profile's patch layer if it is
not already selected. Requires `@deepseek-ai/schemastery` (a DSH host peer) at
runtime.

## Releasing

Push to `main` publishes a GitHub Release tagged `v<version>` with the packed
`pkg.tgz` ([workflow](.github/workflows/release.yml)). Bump `version` in
`package.json` to cut a new release; re-pushing the same version just refreshes
that release's artifact. CI ([ci.yml](.github/workflows/ci.yml)) does a dry-run
pack and verifies every manifest-declared file is included.

