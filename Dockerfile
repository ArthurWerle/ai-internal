FROM denoland/deno:2.8.3

WORKDIR /app

COPY deno.json deno.lock ./
RUN deno install

COPY . .
RUN deno install

EXPOSE 3005

CMD ["sh", "-c", "deno run -A db/drizzle/migrate.ts && deno run -A main.ts"]
