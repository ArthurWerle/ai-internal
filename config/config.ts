export const config = {
  apiKey: process.env.OPENROUTER_API_KEY!,
  mcpApiUrl: process.env.MCP_API_URL,
  httpReferer: '',
  xTitle: 'AI Internal service',
  models: [
    'google/gemini-2.5-flash-lite',
  ],
  // Stronger model for the /ask agentic tool loop; the cheap model above stays
  // for titles and /report-insights.
  agentModels: [
    process.env.AGENT_MODEL ?? 'google/gemini-2.5-flash',
  ],
  agentTemperature: 0.2,
  // Receipt classification (/scan → identifyMessage) uses a stronger model than
  // the cheap default: reading a receipt and picking the right category by
  // establishment needs better instruction-following. Low temperature keeps the
  // category assignment deterministic instead of drifting item-by-item.
  scanModel: process.env.SCAN_MODEL ?? 'google/gemini-2.5-flash',
  scanTemperature: 0.1,
  // LangGraph recursion limit for the agent loop (~2 graph steps per tool round).
  agentRecursionLimit: Number(process.env.AGENT_RECURSION_LIMIT ?? '25'),
  uiGenerationModel: process.env.UI_GENERATION_MODEL ?? 'anthropic/claude-sonnet-4.5',
  provider: {
    sort: {
      by: 'throughput',
      partition: 'none',
    },
  },
  temperature: 0.7,
};


export default config