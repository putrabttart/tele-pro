import dotenv from "dotenv";
import path from "path";
import { z } from "zod";

const rootEnvPath = path.resolve(process.cwd(), "../../.env");
const loadedFromRoot = dotenv.config({ path: rootEnvPath });

if (loadedFromRoot.error) {
  dotenv.config();
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().default(4000),
  JWT_SECRET: z.string().min(12),
  ADMIN_USERNAME: z.string().min(3),
  ADMIN_PASSWORD: z.string().min(3),
  DATABASE_URL: z.string().url(),
  SESSION_ENCRYPTION_KEY: z.string().min(32),
  TELEGRAM_API_ID: z.coerce.number().optional(),
  TELEGRAM_API_HASH: z.string().optional(),
  MIN_SPACING_MS: z.coerce.number().default(5000)
});

export const env = envSchema.parse(process.env);
