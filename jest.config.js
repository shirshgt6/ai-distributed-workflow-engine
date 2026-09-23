// Two Jest "projects":
//   unit        — pure logic + HTTP via Supertest with fake dependencies.
//                 No Docker needed; runs in seconds. (npm test)
//   integration — talks to the REAL Mongo/Redis from docker-compose.
//                 (npm run infra:up && npm run test:integration)
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
  ],
};
