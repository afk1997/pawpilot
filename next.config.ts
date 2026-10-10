import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The production image (docker/Dockerfile) runs the app as `node server.js` from the standalone output.
  output: "standalone",
};

export default nextConfig;
