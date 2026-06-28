import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './db/drizzle/migrations/',
  schema: './db/drizzle/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
