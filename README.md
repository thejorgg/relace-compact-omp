# Relace Compact for OMP and pi-agent ⚡️

Route conversation compaction through [Relace Compact](https://relace.ai/) instead of spending another model request on summarization.

- 🚀 **OMP:** integrates with OMP's native `context-full` compaction path.
- 🧭 **pi-agent:** routes every native compact through Relace and adds percentage/token thresholds plus idle timers.
- 🔐 **Safe configuration:** API keys can come from `RELACE_API_KEY` and project-local settings are only used when trusted.
- 🛠️ **One command:** inspect, enable, disable, reset, or manually compact with `/compact-relace`.

## How it works

1. The host prepares the messages that are eligible for compaction.
2. This extension converts them to Relace's message format and sends them to the configured endpoint.
3. Relace returns a shorter message history.
4. The extension returns that history to the host and persists enough metadata for resumed sessions.
5. New turns are appended after the Relace replacement history.

The extension never implements a second summarizer. It is a transport adapter from OMP/pi-agent to Relace.

## Install

For now, git clone + local install:

```bash
pi install npm:relace-compact-pi
# or
omp plugin install npm:relace-compact-pi
```

For local development:

```bash
git clone https://github.com/thejorgg/relace-compact-pi relace-compact-pi
cd relace-compact-pi
omp plugin install .
# or
pi plugin install .
```

## Configure target and thresholds through the command

You can just run:

``
/compact-relace target [value]
/compact-relace threshold [value]
``

inside pi or omp

## Configure OMP (context-full only) 🧩

OMP's automatic `handoff`, `snapcompact`, `shake`, and `off` strategies are not replaced. Select **Context-full** in OMP's compaction settings.

### 1. Set the Compaction Strategy and Idle Settings

Edit your global configuration (`~/.omp/agent/config.yml`) or your project-local configuration (`.omp/config.yml`) under the `compaction:` block. The plugin automatically respects your native OMP idle settings (`idleEnabled` and `idleTimeoutSeconds`):

```yaml
compaction:
  strategy: context-full
  idleEnabled: true
  idleTimeoutSeconds: 1800
```

> [!IMPORTANT]
> Compaction Strategy must be `context-full` for Relace routing to be active in OMP. The command `/compact-relace status` will show a notice when OMP is not set to `context-full`.

For the idle model overrides, use the following:
```bash
omp plugin config set relace-compact-pi relace.idleModelOverrides "{\"openai/gpt*\":1800,\"openai-codex/gpt*\":1800,\"anthropic/claude*\":300}"
```

Alternatively, use the JSON:

Linux / macOS:
`$HOME/.omp/plugins/omp-plugins.lock.json`

Windows (⚠️ unconfirmed):
`%appdata%/.omp/plugins/omp-plugins.lock.json`

```json
{
  "plugins": {
    "relace-compact-pi": {
      "version": "0.1.0",
      "enabledFeatures": null,
      "enabled": true
    }
  },
  "settings": {
    "relace-compact-pi": {
      "relace.idleModelOverrides": "{\"openai/gpt*\":1800,\"openai-codex/gpt*\":1800,\"anthropic/claude*\":300}"
    }
  }
}
```


### 2. Configure the Relace API Key

The only plugin-specific setting you need to configure is your API key.


#### Option A: Environment variable (Recommended)

```bash
export RELACE_API_KEY="YOUR_RELACE_API_KEY"
```

#### Option B: Using the OMP CLI

```bash
omp plugin config relace-compact-pi set relace.apiKey "YOUR_RELACE_API_KEY"
```

## Configure pi-agent 🤖

Pi-agent reads global settings from `$HOME/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`) and trusted project settings from `.pi/settings.json`.

```json
{
  "relace": {
    "enabled": true,
    "apiKey": "",
    "endpoint": "https://compact.endpoint.relace.run/v1/code/compact",
    "targetPercent": 33,
    "idleTimeoutSeconds": 300,
    "idleModelOverrides": "{\"openai/gpt*\":1800,\"anthropic/claude*\":300}",
    "pi": {
      "thresholdType": "percentage",
      "threshold": 66
    }
  }
}
```

### Settings

| Setting | Default | Description |
| --- | ---: | --- |
| `relace.enabled` | `true` | Enable or disable Relace routing. |
| `relace.apiKey` | empty | Relace API key. `RELACE_API_KEY` takes precedence. |
| `relace.endpoint` | production endpoint | Relace Compact endpoint. |
| `relace.targetPercent` | `33` | Target percentage of the active model context. |
| `relace.idleTimeoutSeconds` | `300` | Global idle compaction delay; `0` disables it. |
| `relace.idleModelOverrides` | `{}` | JSON string mapping model globs to idle seconds. |
| `relace.pi.thresholdType` | `percentage` | Pi threshold interpretation: `percentage` or `tokens`. |
| `relace.pi.threshold` | `66` | Pi compaction threshold. |

Model override examples:

```json
"relace.idleModelOverrides": "{\"openai/gpt*\":1800,\"openai-codex/gpt*\":1800,\"anthropic/claude*\":300}"
```

A pattern containing `/` matches `provider/model`; a pattern without `/` matches the model ID. `*` is the wildcard.

## Commands 💬

```text
/compact-relace
/compact-relace compact
/compact-relace status
/compact-relace enable
/compact-relace disable
/compact-relace reset
/compact-relace target [value]
/compact-relace threshold [value]
```

- Bare `/compact-relace` prints usage.
- `compact` starts a Relace compaction.
- `status` reports host, route, target, context, idle timer, and session count.
- `disable` persists `relace.enabled: false`.
- `enable` persists `relace.enabled: true`.
- `reset` clears the current session's replacement history and counter.
- `target [value]` views the current target percentage, or sets it (e.g. `25%` or `25`).
- `threshold [value]` views the current threshold, or sets it (e.g. `66%`, `5000`, or `5000 tokens`).

## API key and privacy 🔒

```bash
export RELACE_API_KEY="your-relace-key"
```

The extension sends only the messages selected for compaction, the target token count, and the active model identifier to the configured Relace endpoint. Do not configure an untrusted endpoint with a credential you do not intend to share.

## Development

```bash
bun install
bun run check
bun run lint
bun run fmt
```
