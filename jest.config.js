// Three Jest "projects":
//   unit        — pure logic + HTTP via Supertest with fake dependencies.
//                 No Docker needed; runs in seconds. (npm test)
//   integration — talks to the REAL Mongo/Redis/Kafka from docker-compose.
//                 (npm run infra:up && npm run test:integration)
//   llm         — talks to a REAL local model via Ollama (npm run test:llm)
// Keeping them separate means the fast feedback loop never depends on infra.
export default {
  projects: [
    {
      displayName: "unit",
      testEnvironment: "node",
      transform: {}, // native ESM, no Babel
      testMatch: ["<rootDir>/tests/unit/**/*.test.js"],
    },
    {
      displayName: "integration",
      testEnvironment: "node",
      transform: {},
      testMatch: ["<rootDir>/tests/integration/**/*.test.js"],
    },
    {
      // Real LLM (local Ollama). Opt-in: npm run test:llm
      displayName: "llm",
      testEnvironment: "node",
      transform: {},
      testMatch: ["<rootDir>/tests/llm/**/*.test.js"],
    },
  ],
};
