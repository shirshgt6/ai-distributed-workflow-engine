import dotenv from "dotenv";
import { loadConfig } from "../config/env.js";
import { createLogger } from "../config/logger.js";
import { connectMongo, disconnectMongo } from "../config/mongo.js";
import { ProcessedEvent, EventStat } from "../models/analytics.model.js";
import { createAnalyticsProcessor } from "../events/analyticsProcessor.js";
import { createKafkaConsumer } from "../events/kafka.js";

// ANALYTICS CONSUMER:  npm run consumer:analytics
//
// Its own consumer group ("analytics"): it receives every event once per
// group (at least once), independently of any other group. Partitions of the
// topic are split among the group's members, so running several instances
// shares the load. Offsets are committed after each message is processed:
// crash before the commit -> redelivery -> the idempotent processor skips it.
async function main() {
  dotenv.config({ quiet: true });
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, pretty: !config.isProduction }).child({ role: "analytics-consumer" });
  await connectMongo(config.mongo.uri, logger);

  const processor = createAnalyticsProcessor({ ProcessedEvent, EventStat });
  const consumer = createKafkaConsumer({ brokers: config.kafka.brokers, clientId: "analytics", groupId: "analytics" });
  await consumer.connect();
  await consumer.subscribe({ topic: config.kafka.topic, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ partition, message }) => {
      let event;
      try {
        event = JSON.parse(message.value.toString());
      } catch {
        logger.error({ partition, offset: message.offset }, "unparseable event skipped");
        return; // poison message: skip rather than block the partition forever
      }
      const outcome = await processor.process(event);
      logger.debug({ type: event.type, eventId: event.eventId, outcome }, "event processed");
    },
  });
  logger.info({ topic: config.kafka.topic }, "analytics consumer running");

  const shutdown = async () => {
    await consumer.disconnect();
    await disconnectMongo();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  process.stderr.write(`[fatal] analytics consumer failed: ${err.stack ?? err}\n`);
  process.exit(1);
});
