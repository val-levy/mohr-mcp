import { z } from 'zod';

// No trailing slash, so paths can be appended directly.
const baseUrl = z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, ''));

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  PUBLIC_URL: baseUrl,
  SUPABASE_URL: baseUrl,
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
});

export interface Config {
  port: number;
  /** Where this service is reachable from the internet, e.g. https://coach.example.com */
  publicUrl: string;
  supabaseUrl: string;
  /** Safe to send to browsers. */
  supabasePublishableKey: string;
  /** Secret. Used only to remove a person's sign-in when they delete their account. */
  supabaseServiceKey: string;
  /** Connection string of the coach_app role. */
  databaseUrl: string;
}

/** Reads the configuration, naming every missing or malformed variable at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration. ${problems.join('; ')}`);
  }
  return {
    port: parsed.data.PORT,
    publicUrl: parsed.data.PUBLIC_URL,
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabasePublishableKey: parsed.data.SUPABASE_PUBLISHABLE_KEY,
    supabaseServiceKey: parsed.data.SUPABASE_SERVICE_KEY,
    databaseUrl: parsed.data.DATABASE_URL,
  };
}

/** A required variable for the one-off commands, which need far less than the server does. */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set.`);
  return value;
}
