import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: { cpus: 1 },
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
