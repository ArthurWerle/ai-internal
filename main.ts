// Import Langfuse configuration FIRST to initialize OpenTelemetry
import "./config/langfuse.ts";

import Fastify from "fastify";
import health from "@api/rest/health.ts";
import { Drizzle } from "./db/drizzle/drizzle.ts";
import users from "@api/rest/users.ts";
import { OpenRouterService } from "./services/open_router.ts";
import ask from "@api/rest/ask.ts";

const fastify = Fastify({
  logger: true,
});

function addDecorators() {
  const db = new Drizzle().init()
  const openRouterClient = new OpenRouterService()

  fastify.decorate('db', db)
  fastify.decorate('openRouterClient', openRouterClient)
}

function registerRoutes() {
  fastify.register(health);
  fastify.register(users)
  fastify.register(ask)
}

addDecorators()
registerRoutes()

fastify.listen({ port: 3005, host: "0.0.0.0" }, function (err, address) {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`Server listening on ${address}`);
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
