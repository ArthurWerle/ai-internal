import client from "prom-client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// Registry with default Node/Deno runtime metrics (CPU, memory, event loop)
// plus the custom HTTP metrics below.
export const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests processed, by method, route and status.",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds, by method and route.",
  labelNames: ["method", "route"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

// Attaches an onResponse hook that records request count + latency, and a
// GET /metrics route for Prometheus to scrape. Uses the matched route template
// (request.routeOptions.url) so per-id URLs don't blow up label cardinality.
export function registerMetrics(fastify: FastifyInstance): void {
  fastify.addHook("onResponse", (request: FastifyRequest, reply: FastifyReply, done) => {
    const route = request.routeOptions?.url ?? "unmatched";
    const labels = { method: request.method, route };
    httpRequestsTotal.inc({ ...labels, status: String(reply.statusCode) });
    // reply.elapsedTime is in milliseconds.
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
    done();
  });

  fastify.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", register.contentType);
    return await register.metrics();
  });
}
