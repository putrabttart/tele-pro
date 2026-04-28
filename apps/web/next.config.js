const path = require("path");
const dotenv = require("dotenv");

// Monorepo: load .env from project root (../../)
const envPath = path.resolve(__dirname, "../../.env");
const result = dotenv.config({ path: envPath });

// Debug: tampilkan saat build supaya bisa verifikasi
console.log("[next.config] Loading env from:", envPath);
console.log("[next.config] dotenv parse error:", result.error ?? "none");
console.log("[next.config] NEXT_PUBLIC_API_URL =", process.env.NEXT_PUBLIC_API_URL ?? "(NOT SET)");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
};

module.exports = nextConfig;
