import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "unit",
    include: [
      "test/game.test.ts",
      "test/deck.test.ts",
      "test/errors.test.ts",
      "test/id.test.ts",
      "test/routes.test.ts",
    ],
    environment: "node",
  },
});
