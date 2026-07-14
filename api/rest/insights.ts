import type { FastifyInstance } from "fastify";
import { runInsightsAgent } from "../../graph/insights_agent.ts";
import { currentPeriodKey, type Insight } from "../../services/insights.ts";

const KIND = "spending" as const;

// Serializes generations so a burst of requests (or an events retry storm)
// runs the agent once and shares the result instead of burning tokens N times.
let inFlight: Promise<Insight> | null = null;

function generateAndStore(fastify: FastifyInstance, language: string): Promise<Insight> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const periodKey = currentPeriodKey();
    const result = await runInsightsAgent(fastify.openRouterClient, fastify.mcpClient, {
      language,
    });

    if (result.error || !result.insight) {
      throw new Error(result.error ?? "insight generation returned no content");
    }

    return fastify.insightsService.saveActive({
      kind: KIND,
      periodKey,
      content: result.insight,
      metadata: {
        toolsUsed: result.toolsUsed,
        language,
        generatedAt: new Date().toISOString(),
      },
    });
  })();

  return inFlight.finally(() => {
    inFlight = null;
  });
}

function serialize(insight: Insight, cached: boolean) {
  return {
    success: true,
    insight: insight.content,
    periodKey: insight.periodKey,
    generatedAt: insight.createdAt,
    cached,
  };
}

async function routes(fastify: FastifyInstance) {
  // Returns the active insight for the current month. Only generates when
  // there is nothing cached (first hit of the month) or ?refresh=true —
  // otherwise rebuilding is the events queue's job, not the read path's.
  fastify.get("/insights", async (request, reply) => {
    const { refresh, language = "en" } = request.query as {
      refresh?: string;
      language?: string;
    };

    const periodKey = currentPeriodKey();

    if (refresh !== "true") {
      const active = await fastify.insightsService.getActive(KIND, periodKey);
      if (active) return serialize(active, true);
    }

    try {
      const insight = await generateAndStore(fastify, language);
      return serialize(insight, false);
    } catch (error) {
      fastify.log.error(error, "insight generation failed");
      reply.code(502);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // Callback target for the events service, which delivers queued jobs via
  // GET <callback_url>?job_type=...&payload=... — a 2xx marks the job done.
  // Enqueued by the transactions service when a significant transaction is
  // created, so the cached insight is rebuilt off the read path.
  fastify.get("/insights/rebuild", async (request, reply) => {
    const { job_type, language = "en" } = request.query as {
      job_type?: string;
      language?: string;
    };

    fastify.log.info({ jobType: job_type }, "rebuilding spending insight");

    try {
      const insight = await generateAndStore(fastify, language);
      return serialize(insight, false);
    } catch (error) {
      fastify.log.error(error, "insight rebuild failed");
      // Non-2xx so the events service retries with backoff.
      reply.code(502);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export default routes;
