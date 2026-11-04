# dsh-pi-models

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件
> · Oh My DSH（[omdsh-dev](https://github.com/omdsh-dev)）社区项目。

在 DeepSeek Harness 中使用你已为 [pi](https://pi.dev) 配置好的模型。插件读取
pi 的 `models.json`，把每个 provider 转换成一个 `@deepseek-ai/dsh-llm-pi-ai`
条目，并写入该适配器的实时配置项，从而让这些模型以各自的 provider 名、端点、
密钥、上下文窗口和思考等级出现在 Harness 的模型选择器中。

pi 保持唯一数据源。文件被监听：在 `~/.pi/agent/models.json` 中增删或微调某个
模型，Harness 投影无需重启即可随之变化。文件未变化时投影结果完全相同，因此
正常启动不会重写 profile 的配置。

## 映射关系

| pi（`models.json`） | Harness（`llm-pi-ai` 条目） |
| --- | --- |
| `providers.<name>.name` | `displayName` |
| `providers.<name>.baseUrl` | `baseURL` |
| `providers.<name>.api` | `api`（仅 `openai-completions`、`openai-responses`、`anthropic-messages`）|
| `providers.<name>.apiKey` | `apiKeyEnv` —— 字面密钥存入凭据库 `PI_MODELS_<PROVIDER>_API_KEY`；pi 的 `$NAME` 值保留 `NAME` 作为引用；pi 的 `!command` 值每次同步执行一次并以同样方式存储 |
| pi `auth.json` API key | 与 `apiKey` 相同，当 provider 条目没有时启用 |
| `providers.<name>.headers` | `headers`（`$NAME` 值从进程环境解析；`!command` 值不执行，该 header 被丢弃并记录）|
| `providers.<name>.compat` | `compat`（丢弃被扣留的开关）|
| `models[].id`、`name` | model id、显示名 |
| `models[].contextWindow`、`maxTokens`、`input` | 同名字段 |
| `models[].thinkingLevelMap` | `reasoningEfforts`（不提供 `null` 等级）|
| `models[].compat` | model `compat` |

未声明 `api` 或 `baseUrl` 的 provider 会同时从已安装的 pi-ai catalog 继承（例如
`zai-coding-cn`）；已声明的模型从同 id 的 catalog 条目继承能力。

## 刻意不做的事

- 一条 Harness 路由无法表达 per-model 的 `api` 或 `baseUrl`；此类模型会被跳过并
  写日志，而不是被静默误路由。
- `!command` 的 header 值不执行。`!command` 的 API key 仅在 `commandKeys: execute`
  时执行，输出存入 Harness 凭据库；设 `commandKeys: skip` 可避免此类密钥进入凭据库。
- pi OAuth 授权不复制；请从 Harness 模型页重新登录，或为该 provider 配置 API key。
- 只投影 pi `models.json` 声明的模型。设 `includeCatalogModels` 可对未声明任何
  模型的 provider 投影其已安装的 pi-ai catalog。

## 配置

所有字段都是普通配置，可在 profile 的 `cordis.patch.yml` 的 `pi-models` 行下编辑：

```yaml
- id: pi-models
  name: dsh-pi-models
  config:
    piDirectory: ~/.pi/agent      # 默认：$PI_CODING_AGENT_DIR，再回退 ~/.pi/agent
    targetEntry: llm-pi-ai        # 已挂载 pi-ai 适配器的 loader entry id
    apiKeySync: always            # always | if-missing | never
    commandKeys: execute          # execute | skip
    prune: managed                # managed | none | all
    includeCatalogModels: false
    include: []
    exclude: []
    watch: true
    pollIntervalMs: 3000
```

`prune: managed` 仅在 pi 不再声明路由**且**该路由带本桥的 `PI_MODELS_*_API_KEY`
引用时才删除它，因而你在模型页手工添加的路由会保留。`all` 让投影成为 pi 的精确
镜像；`none` 从不删除任何东西。

未知字段会被忽略；字段格式错误会在激活时以点名该字段的消息失败。示例行的 `name`
由 bundle 插入，覆盖项只需 `- id: pi-models` 加你要改的字段。

## 投影写在哪里

投影写入已挂载的 `@deepseek-ai/dsh-llm-pi-ai` 条目（默认 entry id `llm-pi-ai`），
与模型页编辑的位置相同。因此该条目的 `providers` 字典是 pi 声明的每个路由在
`models.json` 上的投影：允许在模型页编辑这些路由，但下一次 `models.json` 同步会
覆盖它们。pi 未声明的 provider 路由会保留。移除本插件后，最后一次投影保留在
原位，仍可使用和继续编辑。

## 开发期间重载

入口模块通过携带实现修改时间的 URL 加载 `src/*.js`，因此重载 `pi-models` 行
（或重装 bundle）会运行磁盘上当前的代码。只有改动 `index.js` 本身需要重启
Harness；`config: { watch: true }` 已能在 `models.json` 变化时无需任何重载即可
重新投影。

## 失败与恢复

- 转换失败的 provider 会被跳过并记录日志，其余投影仍生效。
- 已被其他适配器服务的路由会保留并写日志。
- 若整体配置写入被适配器拒绝（例如协议无法服务的端点），profile 文档保持不变
  并记录错误；修复 pi 条目后，下次文件变化会重试。

## 安装

本插件以 GitHub Release tarball 形式分发（无需 npm 构建步骤）。在 profile 目录
下安装最新 release tag，或下载 pack 后本地安装：

```sh
# 在承载 bundle 的 profile 目录
dsh plugin --profile <profile> add "https://github.com/omdsh-dev/dsh-pi-models/releases/download/v0.1.0/pkg.tgz"
```

或从某个 release 解包 `dist/pkg.tgz`，把 `dsh plugin add` 指向该目录。然后在
profile 的 patch 层启用 `pi-models` 行（若尚未选中）。运行时需要
`@deepseek-ai/schemastery`（DSH 宿主 peer）。

## 发布

推送到 `main` 会发布一个以 `v<version>` 命名的 GitHub Release，内含打包好的
`pkg.tgz`（[workflow](.github/workflows/release.yml)）。修改 `package.json` 中
的 `version` 即可发布新版本；重推相同版本只刷新该 release 的产物。CI
（[ci.yml](.github/workflows/ci.yml)）会做一次 dry-run pack 并校验所有由 manifest
声明的文件都已包含。
