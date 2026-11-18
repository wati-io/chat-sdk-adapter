import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Let the status page live-reload when opened through a dev tunnel.
  allowedDevOrigins: ["*.trycloudflare.com", "*.ngrok-free.app", "*.ngrok.app"],
  // The Redis client uses Node APIs; load it at runtime instead of bundling it.
  serverExternalPackages: ["redis", "@chat-adapter/state-redis"],
};

export default nextConfig;
