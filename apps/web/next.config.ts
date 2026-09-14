import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@habit-app/domain",
    "@habit-app/application",
    "@habit-app/infrastructure",
    "@habit-app/contracts",
  ],
};

export default nextConfig;
