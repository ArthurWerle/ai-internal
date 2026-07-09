export const config = {
  apiKey: process.env.OPENROUTER_API_KEY!,
  mcpApiUrl: process.env.MCP_API_URL,
  httpReferer: '',
  xTitle: 'AI Internal service',
  models: [
    'google/gemini-2.5-flash-lite',
  ],
  provider: {
    sort: {
      by: 'throughput', 
      partition: 'none',
    },
  },
  temperature: 0.7,
};


export default config