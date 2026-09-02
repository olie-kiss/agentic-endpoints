import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
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
