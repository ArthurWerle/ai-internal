import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { OpenRouterService } from "../services/open_router.ts";
import { McpClientService } from "../services/mcp_client.ts";
import { ChatsService } from "../services/chats.ts";
import { InsightsService } from "../services/insights.ts";
import { GeneratedUisService } from "../services/generated_uis.ts";

declare module "fastify" {
  interface FastifyInstance {
    db: NodePgDatabase<any>;
    openRouterClient: OpenRouterService;
    mcpClient: McpClientService;
    chatsService: ChatsService;
    insightsService: InsightsService;
    generatedUisService: GeneratedUisService;
  }
}
