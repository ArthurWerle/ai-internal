FROM denoland/deno:2.3.3

WORKDIR /app

COPY deno.json deno.lock ./
RUN deno install

COPY . .
RUN deno install

EXPOSE 3005

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "main.ts"]
