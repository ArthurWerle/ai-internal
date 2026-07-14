export const config = {
  apiKey: process.env.OPENROUTER_API_KEY!,
  mcpApiUrl: process.env.MCP_API_URL,
  httpReferer: '',
  xTitle: 'AI Internal service',
  models: [
    'google/gemini-2.5-flash-lite',
  ],
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