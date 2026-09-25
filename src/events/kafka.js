import { Kafka, logLevel } from "kafkajs";

/**
 * Kafka publisher used by the outbox relay.
 *
 * idempotent: true makes the PRODUCER's own retries safe (the broker drops a
 * resend of a batch it already wrote in this producer session). It does NOT
 * make the whole pipeline exactly-once: the relay re-sending after a crash
 * is a new session, so duplicates are still possible and consumers dedupe.
 *
 * @param {{ brokers: string[], topic: string, clientId: string, partitions?: number, logger }} options
 */
export function createKafkaPublisher({ brokers, topic, clientId, partitions = 3, logger }) {
  const kafka = new Kafka({ clientId, brokers, logLevel: logLevel.WARN, retry: { retries: 5 } });
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });

  return {
    async connect() {
      const admin = kafka.admin();
      await admin.connect();
      try {
        // Explicit topic creation (auto-create is off): we choose the partition
        // count. More partitions = more parallel consumers in a group.
        await admin.createTopics({ topics: [{ topic, numPartitions: partitions, replicationFactor: 1 }] });
      } finally {
        await admin.disconnect();
      }
      await producer.connect();
      logger.info({ topic }, "kafka publisher connected");
    },

    async publish(messages) {
      await producer.send({ topic, acks: -1, messages });
    },

    async disconnect() {
      await producer.disconnect();
    },
  };
}

/** kafkajs consumer for a consumer group (each group gets every event once per group, at least once). */
export function createKafkaConsumer({ brokers, clientId, groupId }) {
  const kafka = new Kafka({ clientId, brokers, logLevel: logLevel.WARN });
  return kafka.consumer({ groupId });
}
