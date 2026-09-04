import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  // The SDK is a standalone npm package with its own node:test suite and no
  // Workers runtime; running it in the pool fails on the missing bindings.
  test: { include: ["test/**/*.test.ts"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          // Deterministic 32+ char secret so signReceipt does not throw.
          RECEIPT_SECRET: "test-receipt-secret-0123456789abcdef",
        },
      },
    }),
  ],
});
