const path = require("path");
const dotenv = require("dotenv");

// Monorepo: load .env from project root (../../)
const envPath = path.resolve(__dirname, "../../.env");
const result = dotenv.config({ path: envPath });

const apiInternalUrl = (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");

console.log("[next.config] Loading env from:", envPath);
console.log("[next.config] dotenv parse error:", result.error ?? "none");
console.log("[next.config] NEXT_PUBLIC_API_URL =", process.env.NEXT_PUBLIC_API_URL || "(empty -> same-origin rewrite)");
console.log("[next.config] API_INTERNAL_URL =", apiInternalUrl);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_API_TIMEOUT_MS: process.env.NEXT_PUBLIC_API_TIMEOUT_MS,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiInternalUrl}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
