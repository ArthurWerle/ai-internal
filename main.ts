import Fastify from "npm:fastify";
import hello from "@api/rest/hello.ts";

const fastify = Fastify({
  logger: true,
});

fastify.register(hello);

fastify.listen({ port: 3005, host: "0.0.0.0" }, function (err, address) {
  if (err) {
    fastify.log.error(err);
  }
});
