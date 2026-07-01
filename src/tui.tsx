/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup } from "solid-js"
import type { RGBA } from "@opentui/core"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

type LaneStatus = "idle" | "loading" | "ready" | "error"

type LaneView = {
  status: LaneStatus
  text: string
  updatedAt?: number
  source?: string
}

type ActivityEvent = {
  sessionID: string
  time: number
  kind: string
  text: string
}

type DirectModelOptions = {
  baseURL: string | undefined
  apiKey: string | undefined
  apiKeyEnv: string | undefined
  model: string | undefined
  variant: string | undefined
  allowInsecureTLS: boolean
  bodyOptions: Record<string, unknown>
  maxOutputTokens: number
  timeoutMs: number
}

type MicroOptions = DirectModelOptions & {
  enabled: boolean
  debounceMs: number
  eventLimit: number
}

type MacroOptions = DirectModelOptions & {
  enabled: boolean
  intervalMs: number
  maxContextChars: number
  maxMessages: number
}

type PluginOptions = {
  micro: MicroOptions
  macro: MacroOptions
  sidebarOrder: number
  recentEventLimit: number
  keybinds: {
    showSummary: string
    showNative: string
  }
}

type ResolvedChatModel = {
  baseURL: string
  model: string
  apiKey?: string
  bodyOptions: Record<string, unknown>
  label: string
  timeoutMs: number
  allowInsecureTLS: boolean
}

type ExtendedRequestInit = RequestInit & {
  tls?: {
    rejectUnauthorized?: boolean
  }
}

const defaultOptions: PluginOptions = {
  sidebarOrder: 600,
  recentEventLimit: 16,
  keybinds: {
    showSummary: "ctrl+shift+s",
    showNative: "ctrl+shift+n",
  },
  micro: {
    enabled: true,
    baseURL: undefined,
    model: undefined,
    apiKey: undefined,
    apiKeyEnv: "OPENCODE_ACTIVITY_SUMMARY_JUDGE_KEY",
    variant: undefined,
    allowInsecureTLS: false,
    bodyOptions: {},
    maxOutputTokens: 120,
    timeoutMs: 20_000,
    debounceMs: 900,
    eventLimit: 8,
  },
  macro: {
    enabled: true,
    baseURL: undefined,
    apiKey: undefined,
    apiKeyEnv: undefined,
    model: "$model",
    variant: "high",
    allowInsecureTLS: false,
    bodyOptions: {},
    maxOutputTokens: 360,
    timeoutMs: 45_000,
    intervalMs: 30_000,
    maxContextChars: 80_000,
    maxMessages: 80,
  },
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = parseOptions(rawOptions)
  const [micro, setMicro] = createSignal<LaneView>({
    status: "idle",
    text: "等待工具或思考事件。",
  })
  const [macro, setMacro] = createSignal<LaneView>({
    status: "idle",
    text: "等待会话上下文。",
  })
  const [events, setEvents] = createSignal<ActivityEvent[]>([])
  const [lastStatus, setLastStatus] = createSignal("unknown")
  const [sidebarPage, setSidebarPage] = createSignal<"native" | "summary">("native")

  let microTimer: ReturnType<typeof setTimeout> | undefined
  let microInFlight = false
  let macroInFlight = false
  const processedMicroKeys = new Set<string>()

  function pushEvent(event: ActivityEvent) {
    setEvents((current) => [event, ...current].slice(0, options.recentEventLimit))
  }

  function scheduleMicro(sessionID: string, eventText: string) {
    if (!options.micro.enabled) return
    if (microTimer) clearTimeout(microTimer)
    microTimer = setTimeout(() => {
      void runMicroSummary(sessionID, eventText)
    }, options.micro.debounceMs)
  }

  async function runMicroSummary(sessionID: string, eventText: string) {
    if (microInFlight) return
    microInFlight = true
    setMicro({ status: "loading", text: "正在解释当前动作…" })
    try {
      const model = resolveLaneModel(api, options.micro, "unspecified-low")
      if (!model) {
        setMicro({ status: "error", text: "Micro 模型未配置或缺少 API key。" })
        return
      }
      const recent = events()
        .filter((item) => item.sessionID === sessionID)
        .slice(0, options.micro.eventLimit)
        .map((item) => `- ${item.kind}: ${item.text}`)
        .join("\n")
      const answer = await requestChatCompletion(
        model,
        "你是 OpenCode 右侧栏的动作解释器。只根据给定事件说明当前 AI 动作的作用。",
        [
          "用中文输出 1-2 句，最多 80 字。",
          "说明：当前正在干什么；这个工具/命令/思考的作用是什么。",
          "不要编造，不要建议用户操作，不要输出标题。",
          "",
          `当前事件：${eventText}`,
          "",
          "最近事件：",
          recent || "暂无",
        ].join("\n"),
        options.micro.maxOutputTokens,
      )
      setMicro({ status: "ready", text: answer, updatedAt: Date.now(), source: model.label })
    } catch (error) {
      setMicro({ status: "error", text: errorMessage(error), updatedAt: Date.now() })
    } finally {
      microInFlight = false
    }
  }

  async function runMacroSummary(sessionID: string, reason: string) {
    if (!options.macro.enabled || macroInFlight) return
    macroInFlight = true
    setMacro((current) => ({ ...current, status: "loading", text: current.text || "正在总结上下文…" }))
    try {
      const model = resolveLaneModel(api, options.macro, "unspecified-high")
      if (!model) {
        setMacro({ status: "error", text: "Macro 模型未配置、不是 OpenAI-compatible，或缺少 API key。" })
        return
      }
      const context = buildSessionContext(api, sessionID, options.macro.maxMessages, options.macro.maxContextChars)
      const recent = events()
        .filter((item) => item.sessionID === sessionID)
        .slice(0, options.recentEventLimit)
        .map((item) => `- ${new Date(item.time).toLocaleTimeString()}: ${item.kind}: ${item.text}`)
        .join("\n")
      const answer = await requestChatCompletion(
        model,
        "你是 OpenCode 右侧栏的全局进展总结器。你只总结给定会话上下文，不执行任何任务。",
        [
          "请用中文极简总结当前 OpenCode 会话。固定输出 5 行：",
          "目标：...",
          "已做：...",
          "当前：...",
          "下一步：...",
          "风险：...",
          "要求：每行一句话；没有证据就写“暂不明确”；不要展开解释。",
          "",
          `触发原因：${reason}`,
          `当前 session status：${lastStatus()}`,
          "",
          "最近事件：",
          recent || "暂无",
          "",
          "会话上下文：",
          context,
        ].join("\n"),
        options.macro.maxOutputTokens,
      )
      setMacro({ status: "ready", text: answer, updatedAt: Date.now(), source: model.label })
    } catch (error) {
      setMacro({ status: "error", text: errorMessage(error), updatedAt: Date.now() })
    } finally {
      macroInFlight = false
    }
  }

  const unsubscribePartUpdated = api.event.on("message.part.updated", (event) => {
    const part = event.properties.part
    const summary = summarizePart(part)
    if (!summary) return
    pushEvent({
      sessionID: event.properties.sessionID,
      time: event.properties.time,
      kind: summary.kind,
      text: summary.text,
    })
    const microKey = microTriggerKey(part)
    if (!microKey || processedMicroKeys.has(microKey)) return
    processedMicroKeys.add(microKey)
    scheduleMicro(event.properties.sessionID, `${summary.kind}: ${summary.text}`)
  })

  const unsubscribeSessionStatus = api.event.on("session.status", (event) => {
    const status = compactJson(event.properties.status, 280)
    setLastStatus(status)
    pushEvent({
      sessionID: event.properties.sessionID,
      time: Date.now(),
      kind: "status",
      text: status,
    })
  })

  const unsubscribeSessionIdle = api.event.on("session.idle", (event) => {
    setLastStatus("idle")
    pushEvent({
      sessionID: event.properties.sessionID,
      time: Date.now(),
      kind: "status",
      text: "session idle",
    })
  })

  api.slots.register({
    order: options.sidebarOrder,
    slots: {
      sidebar_content(ctx, value) {
        if (sidebarPage() !== "summary") return null
        return (
          <ActivityPanel
            sessionID={value.session_id}
            micro={micro()}
            macro={macro()}
            events={events().filter((item) => item.sessionID === value.session_id)}
            theme={ctx.theme.current}
            intervalMs={options.macro.intervalMs}
            runMacro={(reason) => runMacroSummary(value.session_id, reason)}
          />
        )
      },
    },
  })

  const unregisterCommands = api.command.register(() => [
    {
      title: "Show activity summary sidebar",
      value: "activity-summary.show",
      description: "Switch the sidebar to the activity summary page",
      category: "Plugin",
      keybind: options.keybinds.showSummary,
      slash: { name: "activity-summary" },
      onSelect: () => setSidebarPage("summary"),
    },
    {
      title: "Show native sidebar",
      value: "activity-summary.native",
      description: "Switch the sidebar back to OpenCode native context, MCP, LSP, todo, and file panels",
      category: "Plugin",
      keybind: options.keybinds.showNative,
      slash: { name: "sidebar-native" },
      onSelect: () => setSidebarPage("native"),
    },
  ])

  api.lifecycle.onDispose(() => {
    if (microTimer) clearTimeout(microTimer)
    unsubscribePartUpdated()
    unsubscribeSessionStatus()
    unsubscribeSessionIdle()
    unregisterCommands()
  })
}

function ActivityPanel(props: {
  sessionID: string
  micro: LaneView
  macro: LaneView
  events: ActivityEvent[]
  theme: SummaryTheme
  intervalMs: number
  runMacro: (reason: string) => Promise<void>
}) {
  const recent = () => props.events.slice(0, 4)
  const initialTimer = setTimeout(() => {
    void props.runMacro("initial")
  }, 1_200)
  const interval = setInterval(() => {
    void props.runMacro("interval")
  }, props.intervalMs)
  onCleanup(() => {
    clearTimeout(initialTimer)
    clearInterval(interval)
  })

  return (
    <box
      position="absolute"
      zIndex={1200}
      top={0}
      bottom={0}
      left={0}
      right={0}
      height="100%"
      width="100%"
      flexDirection="column"
      backgroundColor={props.theme.backgroundPanel}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
    >
      <text fg={props.theme.primary}>Activity Summary</text>
      <Divider theme={props.theme} />
      <SummaryBlock title="当前动作" view={props.micro} theme={props.theme} />
      <Divider theme={props.theme} />
      <SummaryBlock title="全局进展" view={props.macro} theme={props.theme} />
      <Divider theme={props.theme} />
      <RecentEventsBlock events={recent()} theme={props.theme} />
    </box>
  )
}

function Divider(props: { theme: SummaryTheme }) {
  return <box height={1} flexShrink={0} border={["top"]} borderColor={props.theme.border} />
}

function SummaryBlock(props: {
  title: string
  view: LaneView
  theme: SummaryTheme
}) {
  const color = () => (props.view.status === "error" ? props.theme.error : props.view.status === "loading" ? props.theme.warning : props.theme.text)
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={props.theme.primary}>{props.title}</text>
      {splitLines(props.view.text).map((line) => (
        <text fg={color()}>{line}</text>
      ))}
    </box>
  )
}

function RecentEventsBlock(props: { events: ActivityEvent[]; theme: SummaryTheme }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={props.theme.primary}>最近事件</text>
      {props.events.length === 0 ? <text fg={props.theme.textMuted}>暂无事件</text> : null}
      {props.events.map((item) => (
        <text fg={props.theme.textMuted}>• {truncate(`${item.kind}: ${item.text}`, 70)}</text>
      ))}
    </box>
  )
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode.activity-summary",
  tui,
}

export default plugin

type SummaryTheme = {
  text: RGBA
  textMuted: RGBA
  border: RGBA
  backgroundPanel: RGBA
  primary: RGBA
  warning: RGBA
  error: RGBA
  success: RGBA
}

function parseOptions(raw: unknown): PluginOptions {
  const root = asRecord(raw)
  return {
    sidebarOrder: numberOption(root.sidebarOrder, defaultOptions.sidebarOrder),
    recentEventLimit: numberOption(root.recentEventLimit, defaultOptions.recentEventLimit),
    keybinds: parseKeybindOptions(root.keybinds),
    micro: parseMicroOptions(root.micro),
    macro: parseMacroOptions(root.macro),
  }
}

function parseKeybindOptions(raw: unknown): PluginOptions["keybinds"] {
  const input = asRecord(raw)
  return {
    showSummary: stringOption(input.showSummary, defaultOptions.keybinds.showSummary) ?? defaultOptions.keybinds.showSummary,
    showNative: stringOption(input.showNative, defaultOptions.keybinds.showNative) ?? defaultOptions.keybinds.showNative,
  }
}

function parseMicroOptions(raw: unknown): MicroOptions {
  const input = asRecord(raw)
  return {
    enabled: booleanOption(input.enabled, defaultOptions.micro.enabled),
    baseURL: stringOption(input.baseURL, defaultOptions.micro.baseURL),
    apiKey: stringOption(input.apiKey, defaultOptions.micro.apiKey),
    apiKeyEnv: stringOption(input.apiKeyEnv, defaultOptions.micro.apiKeyEnv),
    model: stringOption(input.model, defaultOptions.micro.model),
    variant: stringOption(input.variant, defaultOptions.micro.variant),
    allowInsecureTLS: booleanOption(input.allowInsecureTLS, defaultOptions.micro.allowInsecureTLS),
    bodyOptions: asRecord(input.bodyOptions),
    maxOutputTokens: numberOption(input.maxOutputTokens, defaultOptions.micro.maxOutputTokens),
    timeoutMs: numberOption(input.timeoutMs, defaultOptions.micro.timeoutMs),
    debounceMs: numberOption(input.debounceMs, defaultOptions.micro.debounceMs),
    eventLimit: numberOption(input.eventLimit, defaultOptions.micro.eventLimit),
  }
}

function parseMacroOptions(raw: unknown): MacroOptions {
  const input = asRecord(raw)
  return {
    enabled: booleanOption(input.enabled, defaultOptions.macro.enabled),
    baseURL: stringOption(input.baseURL, defaultOptions.macro.baseURL),
    apiKey: stringOption(input.apiKey, defaultOptions.macro.apiKey),
    apiKeyEnv: stringOption(input.apiKeyEnv, defaultOptions.macro.apiKeyEnv),
    model: stringOption(input.model, defaultOptions.macro.model),
    variant: stringOption(input.variant, defaultOptions.macro.variant),
    allowInsecureTLS: booleanOption(input.allowInsecureTLS, defaultOptions.macro.allowInsecureTLS),
    bodyOptions: asRecord(input.bodyOptions),
    maxOutputTokens: numberOption(input.maxOutputTokens, defaultOptions.macro.maxOutputTokens),
    timeoutMs: numberOption(input.timeoutMs, defaultOptions.macro.timeoutMs),
    intervalMs: numberOption(input.intervalMs, defaultOptions.macro.intervalMs),
    maxContextChars: numberOption(input.maxContextChars, defaultOptions.macro.maxContextChars),
    maxMessages: numberOption(input.maxMessages, defaultOptions.macro.maxMessages),
  }
}

function resolveLaneModel(api: TuiPluginApi, lane: DirectModelOptions, label: string): ResolvedChatModel | undefined {
  const direct = resolveDirectModel(lane, label)
  if (direct) return direct
  if (!lane.model) return undefined
  return resolveConfiguredModel(api, lane.model, lane.variant, label, lane.timeoutMs)
}

function resolveDirectModel(lane: DirectModelOptions, label: string): ResolvedChatModel | undefined {
  if (!lane.baseURL || !lane.model) return undefined
  const apiKey = lane.apiKey ?? envValue(lane.apiKeyEnv)
  if (!apiKey) return undefined
  return {
    baseURL: lane.baseURL,
    model: lane.model,
    apiKey,
    bodyOptions: lane.bodyOptions,
    label: `${label}:${lane.model}`,
    timeoutMs: lane.timeoutMs,
    allowInsecureTLS: lane.allowInsecureTLS,
  }
}

function resolveConfiguredModel(
  api: TuiPluginApi,
  modelRef: string,
  variant: string | undefined,
  label: string,
  timeoutMs: number,
): ResolvedChatModel | undefined {
  const config = asRecord(api.state.config)
  const resolvedRef = resolveModelReference(config, modelRef)
  if (!resolvedRef) return undefined
  const parsed = parseModelReference(resolvedRef)
  if (!parsed) return undefined
  const providers = asRecord(config.provider)
  const provider = asRecord(providers[parsed.providerID])
  const providerOptions = asRecord(provider.options)
  const baseURL = stringValue(providerOptions.baseURL) ?? stringValue(providerOptions.baseUrl)
  const apiKey = stringValue(providerOptions.apiKey) ?? envValue(stringValue(providerOptions.apiKeyEnv))
  if (!baseURL || !apiKey) return undefined
  const models = asRecord(provider.models)
  const modelConfig = asRecord(models[parsed.modelID])
  const bodyOptions = {
    ...asRecord(modelConfig.options),
    ...variantOptions(modelConfig, variant),
  }
  return {
    baseURL,
    model: parsed.modelID,
    apiKey,
    bodyOptions,
    label: `${label}:${parsed.providerID}/${parsed.modelID}${variant ? `:${variant}` : ""}`,
    timeoutMs,
    allowInsecureTLS: false,
  }
}

function resolveModelReference(config: Record<string, unknown>, modelRef: string): string | undefined {
  if (modelRef === "$model") return stringValue(config.model)
  if (modelRef === "$small_model") return stringValue(config.small_model) ?? stringValue(config.model)
  return modelRef
}

function parseModelReference(modelRef: string): { providerID: string; modelID: string } | undefined {
  const index = modelRef.indexOf("/")
  if (index <= 0 || index >= modelRef.length - 1) return undefined
  return { providerID: modelRef.slice(0, index), modelID: modelRef.slice(index + 1) }
}

function variantOptions(modelConfig: Record<string, unknown>, variant: string | undefined): Record<string, unknown> {
  if (!variant) return {}
  const variants = asRecord(modelConfig.variants)
  return asRecord(variants[variant])
}

async function requestChatCompletion(
  model: ResolvedChatModel,
  system: string,
  user: string,
  maxOutputTokens: number,
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), model.timeoutMs)
  try {
    const request: ExtendedRequestInit = {
      method: "POST",
      signal: controller.signal,
      headers: chatHeaders(model.apiKey),
      body: JSON.stringify({
        ...model.bodyOptions,
        model: model.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        max_tokens: maxOutputTokens,
        stream: false,
      }),
    }
    if (model.allowInsecureTLS) request.tls = { rejectUnauthorized: false }
    const response = await fetch(chatCompletionsUrl(model.baseURL), request)
    const payload = await response.text()
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${truncate(redactSecrets(payload), 300)}`)
    }
    const parsed: unknown = payload ? JSON.parse(payload) : {}
    const content = extractAssistantContent(parsed)
    if (!content && hasReasoningOnlyContent(parsed)) {
      throw new Error(
        "Model response only contained reasoning, not assistant content. Disable thinking for this model; for Qwen-compatible servers set bodyOptions.enable_thinking=false or bodyOptions.chat_template_kwargs.enable_thinking=false.",
      )
    }
    if (!content) throw new Error("Model response did not contain assistant content")
    return content.trim()
  } finally {
    clearTimeout(timeout)
  }
}

function chatCompletionsUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "")
  if (trimmed.endsWith("/chat/completions")) return trimmed
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

function chatHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  return headers
}

function extractAssistantContent(payload: unknown): string | undefined {
  const root = asRecord(payload)
  const choices = Array.isArray(root.choices) ? root.choices : []
  const first = choices[0]
  const choice = asRecord(first)
  const message = asRecord(choice.message)
  const content = message.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((item) => stringValue(asRecord(item).text) ?? stringValue(asRecord(item).content))
      .filter(isNonEmptyString)
      .join("\n")
  }
  const text = choice.text
  return typeof text === "string" ? text : undefined
}

function hasReasoningOnlyContent(payload: unknown): boolean {
  const root = asRecord(payload)
  const choices = Array.isArray(root.choices) ? root.choices : []
  const first = choices[0]
  const choice = asRecord(first)
  const message = asRecord(choice.message)
  const reasoning = stringValue(message.reasoning) ?? stringValue(message.reasoning_content)
  if (!reasoning) return false
  const content = message.content
  if (typeof content === "string" && content.trim().length > 0) return false
  if (Array.isArray(content)) {
    return content.every((item) => {
      const record = asRecord(item)
      const text = stringValue(record.text) ?? stringValue(record.content)
      return !text || text.trim().length === 0
    })
  }
  return true
}

function buildSessionContext(api: TuiPluginApi, sessionID: string, maxMessages: number, maxChars: number): string {
  const messages = api.state.session.messages(sessionID).slice(-maxMessages)
  const lines: string[] = []
  const todos = api.state.session.todo(sessionID)
  if (todos.length > 0) {
    lines.push("## Todo")
    for (const todo of todos) lines.push(`- [${todo.status}] ${todo.content}`)
    lines.push("")
  }
  const diff = api.state.session.diff(sessionID)
  if (diff.length > 0) {
    lines.push("## Files changed")
    for (const item of diff.slice(0, 20)) lines.push(`- ${item.file} (+${item.additions}/-${item.deletions})`)
    lines.push("")
  }
  lines.push("## Messages")
  for (const message of messages) {
    lines.push(formatMessage(api, message))
  }
  return truncateMiddle(lines.join("\n"), maxChars)
}

function formatMessage(api: TuiPluginApi, message: Message): string {
  const parts = api.state.part(message.id)
  const lines = [`### ${message.role} ${message.id}`]
  for (const part of parts) {
    const text = formatPartForContext(part)
    if (text) lines.push(text)
  }
  return lines.join("\n")
}

function formatPartForContext(part: Part): string | undefined {
  switch (part.type) {
    case "text":
      return part.synthetic ? undefined : `text: ${redactSecrets(truncate(part.text, 4_000))}`
    case "reasoning":
      return `reasoning: ${redactSecrets(truncate(part.text, 2_500))}`
    case "tool":
      return formatToolPart(part)
    case "patch":
      return `patch: ${part.files.join(", ")}`
    case "subtask":
      return `subtask(${part.agent}): ${truncate(part.description || part.prompt, 1_000)}`
    case "agent":
      return `agent: ${part.name}`
    case "compaction":
      return `compaction: auto=${part.auto}${part.overflow ? " overflow=true" : ""}`
    case "step-finish":
      return `step-finish: ${part.reason}`
    case "file":
      return `file: ${part.filename ?? part.mime}`
    case "retry":
      return `retry: attempt ${part.attempt}`
    case "snapshot":
    case "step-start":
      return part.type
  }
}

function summarizePart(part: Part): { kind: string; text: string } | undefined {
  if (part.type === "tool") return summarizeToolPart(part)
  if (part.type === "reasoning" && part.time.end && part.text.trim().length > 0) {
    return { kind: "thinking", text: truncate(redactSecrets(part.text), 1_000) }
  }
  if (part.type === "patch") return { kind: "patch", text: `modified ${part.files.join(", ")}` }
  if (part.type === "subtask") return { kind: "subtask", text: `${part.agent}: ${part.description}` }
  return undefined
}

function summarizeToolPart(part: Extract<Part, { type: "tool" }>): { kind: string; text: string } {
  const state = part.state
  const input = compactJson(state.input, 800)
  if (state.status === "completed") {
    return { kind: `tool:${part.tool}:completed`, text: `${state.title || input}; output=${truncate(redactSecrets(state.output), 700)}` }
  }
  if (state.status === "error") {
    return { kind: `tool:${part.tool}:error`, text: `${input}; error=${truncate(redactSecrets(state.error), 700)}` }
  }
  if (state.status === "running") {
    return { kind: `tool:${part.tool}:running`, text: state.title ? `${state.title}; input=${input}` : input }
  }
  return { kind: `tool:${part.tool}:pending`, text: input }
}

function formatToolPart(part: Extract<Part, { type: "tool" }>): string {
  const summary = summarizeToolPart(part)
  return `${summary.kind}: ${summary.text}`
}

function microTriggerKey(part: Part): string | undefined {
  if (part.type === "tool") {
    const state = part.state
    const suffix = state.status === "running" ? "running" : state.status === "pending" ? "pending" : `${state.status}:${state.time.end}`
    return `${part.id}:${suffix}`
  }
  if (part.type === "reasoning" && part.time.end && part.text.trim().length > 0) return `${part.id}:reasoning:${part.time.end}`
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function stringOption(value: unknown, fallback: string | undefined): string | undefined {
  return stringValue(value) ?? fallback
}

function numberOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function booleanOption(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function envValue(name: string | undefined): string | undefined {
  if (!name) return undefined
  return stringValue(process.env[name])
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function compactJson(value: unknown, maxLength: number): string {
  try {
    return truncate(redactSecrets(JSON.stringify(value)), maxLength)
  } catch {
    return truncate(redactSecrets(String(value)), maxLength)
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const head = Math.floor(maxLength * 0.55)
  const tail = Math.max(0, maxLength - head - 40)
  return `${value.slice(0, head)}\n...[truncated ${value.length - head - tail} chars]...\n${value.slice(value.length - tail)}`
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).flatMap((line) => wrapLine(line, 42))
}

function wrapLine(value: string, width: number): string[] {
  if (value.length <= width) return [value]
  const result: string[] = []
  let rest = value
  while (rest.length > width) {
    result.push(rest.slice(0, width))
    rest = rest.slice(width)
  }
  if (rest) result.push(rest)
  return result
}

function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***")
    .replace(/sk-or-v1-[A-Za-z0-9_-]{12,}/g, "sk-or-v1-***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer ***")
    .replace(/("apiKey"\s*:\s*")[^"]+(")/gi, "$1***$2")
    .replace(/("key"\s*:\s*")[^"]{12,}(")/gi, "$1***$2")
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
