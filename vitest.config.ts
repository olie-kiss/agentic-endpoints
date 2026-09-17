import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { handleOutbound } from "./test/outbound-stub";

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

        /**
         * The facilitator and the Base RPC nodes are unreachable from the
         * test runtime, which left the payment-challenge tests asserting
         * against a 503 from a failed pre-flight rather than the 402 the
         * product actually serves. Stubbing them here is what lets the gate
         * be tested at all; every other host still refuses to connect.
         */
        outboundService: handleOutbound,
      },
    }),
  ],
});
