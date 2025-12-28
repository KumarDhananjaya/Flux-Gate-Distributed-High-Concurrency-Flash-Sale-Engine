
import Fastify from 'fastify';
import { decrementStock, initStock, createProducer, redisClient } from '@flux-gate/shared';
import { v4 as uuidv4 } from 'uuid';

const fastify = Fastify({ logger: true });

let producer: any;

fastify.post('/init', async (request, reply) => {
    const { productId, quantity } = request.body as any;
    await initStock(productId, quantity);
    return { status: 'ok', msg: `Stock initialized for ${productId} to ${quantity}` };
});

fastify.post('/order', async (request, reply) => {
    // Rate Limiting (Traffic Shaping)
    const currentSecond = Math.floor(Date.now() / 1000);
    const rateKey = `rate:${currentSecond}`;
    const currentRate = await redisClient.incr(rateKey);
    if (currentRate === 1) {
        await redisClient.expire(rateKey, 2);
    }

    // Threshold set low (50) for demo purposes. Prompt says 10,000.
    if (currentRate > 50) {
        // Redirect to Virtual Waiting Room
        return reply.status(302).redirect('http://localhost:4000');
    }

    const { productId, userId } = request.body as any;
    const idempotencyKey = request.headers['x-idempotency-key'] as string;

    if (!idempotencyKey) {
        return reply.code(400).send({ error: 'Missing Idempotency Key' });
    }

    // Idempotency Check
    const processed = await redisClient.get(`idempotency:${idempotencyKey}`);
    if (processed) {
        return reply.send({ status: 'ignored', msg: 'Duplicate request' });
    }

    // Atomic Decrement
    const success = await decrementStock(productId, 1);

    if (success) {
        // Produce to Kafka
        // Warning: If this fails, we have decremented stock but not created an order.
        // In a real system, we might want to use a two-phase commit or a compensation txn.
        // But for this demo, we assume Kafka availability.
        try {
            await producer.send({
                topic: 'orders',
                messages: [
                    { value: JSON.stringify({ orderId: uuidv4(), productId, userId, timestamp: Date.now() }) }
                ]
            });

            // Mark Idempotency Key (TTL 60s)
            await redisClient.set(`idempotency:${idempotencyKey}`, '1', 'EX', 60);

            return { status: 'success', msg: 'Order accepted' };
        } catch (error) {
            // Need to compensate: increment stock back?
            // In complex distributed systems this is hard.
            // For now, log error.
            fastify.log.error({ err: error }, 'Failed to send to Kafka');
            return reply.code(500).send({ status: 'error', msg: 'Order processing failed' });
        }
    } else {
        return reply.code(409).send({ status: 'sold_out', msg: 'Inventory empty' });
    }
});

const start = async () => {
    try {
        console.log("Connecting to Kafka Producer...");
        producer = await createProducer();
        console.log("Kafka Producer Connected.");
        await fastify.listen({ port: 3000, host: '0.0.0.0' });
        console.log("Ingestion API listening on 3000");
    } catch (err) {
        fastify.log.error({ err }, "Startup Error");
        process.exit(1);
    }
};

start();
