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
git clone https://github.com/thejorgg/relace-compact-omp relace-compact-omp
cd relace-compact-omp
omp plugin link .
# or
pi install .
```

## Configure OMP (context-full only) 🧩

OMP's automatic `handoff`, `snapcompact`, `shake`, and `off` strategies are not replaced. Select **Context-full** in OMP's compaction settings:

```yaml
compaction:
  strategy: context-full
```

Then configure the plugin:

```bash
omp plugin config relace-compact-omp --set relace.apiKey="$RELACE_API_KEY"
omp plugin config relace-compact-omp --set relace.targetPercent=50
```

Or use the OMP plugin settings UI. The important requirement is:

> **Compaction Strategy must be `context-full` for Relace routing to be active in OMP.**

`/compact-relace status` shows a notice when OMP is not set to `context-full`:

```text
Notice: change Compaction Strategy to context-full to use Relace.
```

Relace's target is model-relative: `relace.targetPercent: 50` requests approximately half of the active model's context window as the post-compaction target. The status command displays both the percentage and the calculated token target.

## Configure pi-agent 🤖

Pi-agent reads global settings from `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`) and trusted project settings from `.pi/settings.json`.

```json
{
  "relace": {
    "enabled": true,
    "apiKey": "",
    "endpoint": "https://compact.endpoint.relace.run/v1/code/compact",
    "targetPercent": 50,
    "idleTimeoutSeconds": 300,
    "idleModelOverrides": "{\"openai/gpt*\":1800,\"anthropic/claude*\":300}",
    "pi": {
      "thresholdType": "percentage",
      "threshold": 80
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
| `relace.targetPercent` | `50` | Target percentage of the active model context. |
| `relace.idleTimeoutSeconds` | `300` | Global idle compaction delay; `0` disables it. |
| `relace.idleModelOverrides` | `{}` | JSON string mapping model globs to idle seconds. |
| `relace.pi.thresholdType` | `percentage` | Pi threshold interpretation: `percentage` or `tokens`. |
| `relace.pi.threshold` | `80` | Pi compaction threshold. |

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
```

- Bare `/compact-relace` prints usage.
- `compact` starts a Relace compaction.
- `status` reports host, route, target, context, idle timer, and session count.
- `disable` persists `relace.enabled: false`.
- `enable` persists `relace.enabled: true`.
- `reset` clears the current session's replacement history and counter.

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

## License

MIT © The Relace Compact contributors
