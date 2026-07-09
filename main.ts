// Import Langfuse configuration FIRST to initialize OpenTelemetry
import "./config/langfuse.ts";

import Fastify from "fastify";
import cors from "@fastify/cors";
import health from "@api/rest/health.ts";
import { Drizzle } from "./db/drizzle/drizzle.ts";
import { OpenRouterService } from "./services/open_router.ts";
import { McpClientService } from "./services/mcp_client.ts";
import ask from "@api/rest/ask.ts";
import scanner from "@api/rest/scanner.ts";
import reportInsights from "@api/rest/report_insights.ts";

const fastify = Fastify({
  logger: true,
});

function addDecorators() {
  const db = new Drizzle().init()
  const openRouterClient = new OpenRouterService()
  const mcpClient = new McpClientService()

  fastify.decorate('db', db)
  fastify.decorate('openRouterClient', openRouterClient)
  fastify.decorate('mcpClient', mcpClient)
}

async function registerRoutes() {
  await fastify.register(cors, {
    origin: true,
  });

  await fastify.register(health);
  await fastify.register(ask);
  await fastify.register(scanner);
  await fastify.register(reportInsights);
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
