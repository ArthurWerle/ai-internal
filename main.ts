import Fastify from 'fastify'
import hello from './api/rest/hello'

const fastify = Fastify({
  logger: true
})

fastify.register(hello)

fastify.listen({ port: 3000 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
  }
})