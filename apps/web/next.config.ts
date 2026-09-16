import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.FANTASY_NEXT_DIST_DIR || ".next",
  experimental: { cpus: 1 },
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
