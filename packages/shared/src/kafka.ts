
import { Kafka, Producer, Consumer } from 'kafkajs';

export const kafka = new Kafka({
    clientId: 'flux-gate',
    brokers: [(process.env.KAFKA_BROKER || 'localhost:9093')],
});

export const createProducer = async (): Promise<Producer> => {
    const producer = kafka.producer();
    await producer.connect();
    return producer;
};

export const createConsumer = async (groupId: string): Promise<Consumer> => {
    const consumer = kafka.consumer({ groupId });
    await consumer.connect();
    return consumer;
};
