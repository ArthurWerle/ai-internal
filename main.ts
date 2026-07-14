// Import Langfuse configuration FIRST to initialize OpenTelemetry
import "./config/langfuse.ts";

import Fastify from "fastify";
import cors from "@fastify/cors";
import health from "@api/rest/health.ts";
import { Drizzle } from "./db/drizzle/drizzle.ts";
import { OpenRouterService } from "./services/open_router.ts";
import { McpClientService } from "./services/mcp_client.ts";
import { ChatsService } from "./services/chats.ts";
import { InsightsService } from "./services/insights.ts";
import ask from "@api/rest/ask.ts";
import scanner from "@api/rest/scanner.ts";
import reportInsights from "@api/rest/report_insights.ts";
import chats from "@api/rest/chats.ts";
import generateUi from "@api/rest/generate_ui.ts";
import insights from "@api/rest/insights.ts";

const fastify = Fastify({
  logger: true,
});

function addDecorators() {
  const db = new Drizzle().init()
  const openRouterClient = new OpenRouterService()
  const mcpClient = new McpClientService()
  const chatsService = new ChatsService(db)
  const insightsService = new InsightsService(db)

  fastify.decorate('db', db)
  fastify.decorate('openRouterClient', openRouterClient)
  fastify.decorate('mcpClient', mcpClient)
  fastify.decorate('chatsService', chatsService)
  fastify.decorate('insightsService', insightsService)
}

async function registerRoutes() {
  await fastify.register(cors, {
    origin: true,
  });

  await fastify.register(health);
  await fastify.register(ask);
  await fastify.register(scanner);
  await fastify.register(reportInsights);
  await fastify.register(chats);
  await fastify.register(generateUi);
  await fastify.register(insights);
}

async function start() {
  addDecorators();
  await registerRoutes();

  const address = await fastify.listen({ port: 3005, host: "0.0.0.0" });
  console.log(`Server listening on ${address}`);
}

start().catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});

const gracefulShutdown = async () => {
  console.log('Shutting down gracefully...');
  await fastify.close();

  const { langfuseSpanProcessor } = await import('./config/langfuse.ts');
  await langfuseSpanProcessor.forceFlush();

  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
