import Fastify from "fastify";
import health from "@api/rest/health.ts";
import { Drizzle } from "./db/drizzle/drizzle.ts";
import users from "@api/rest/users.ts";

const fastify = Fastify({
  logger: true,
});

function addDecorators() {
  const db = new Drizzle().init()

  fastify.decorate('db', db)
}

function registerRoutes() {
  fastify.register(health);
  fastify.register(users)
}

addDecorators()
registerRoutes()

fastify.listen({ port: 3005, host: "0.0.0.0" }, function (err, address) {
  if (err) {
    fastify.log.error(err);
  }
});
