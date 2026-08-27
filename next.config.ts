import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // mupdf ships a WASM binary that must be loaded from disk at runtime via
  // `fs.readFileSync(new URL("mupdf-wasm.wasm", import.meta.url))`. Keeping the
  // package external stops Next.js from bundling it, so that relative lookup
  // resolves against the real file in node_modules.
  serverExternalPackages: ["mupdf"],
};

export default nextConfig;
