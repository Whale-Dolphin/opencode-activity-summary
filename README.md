# opencode-activity-summary

OpenCode TUI sidebar plugin that explains what the agent is doing.

## Lanes

- **Micro**: triggered by tool/reasoning updates, summarizes the current action.
- **Macro**: triggered on an interval, summarizes the broader goal, completed work, current state, next step, and risks.

The plugin is intentionally read-only for the active session. It does not send prompts into the current OpenCode conversation.

## Local TUI config example

Use `~/.config/opencode/tui.json`:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "/absolute/path/to/opencode-activity-summary/src/tui.tsx",
      {
        "micro": {
          "baseURL": "https://your-openai-compatible-host/v1",
          "model": "your-small-summary-model",
          "apiKeyEnv": "OPENCODE_ACTIVITY_SUMMARY_JUDGE_KEY"
        },
        "macro": {
          "model": "$model",
          "variant": "high",
          "intervalMs": 30000
        }
      }
    ]
  ]
}
```

Do not commit real API keys. Prefer `apiKeyEnv` for shared configs.

`micro.baseURL` and `macro.baseURL` must point to an OpenAI-compatible Chat Completions endpoint. The plugin deliberately has no remote endpoint enabled by default.
