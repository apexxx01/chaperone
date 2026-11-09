import { defineConfig } from "vitest/config";
export default defineConfig({ test: { env: { CHAPERONE_MODE: "offline" }, testTimeout: 20000 } });
