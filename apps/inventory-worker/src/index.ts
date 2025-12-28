
import { createConsumer } from '@flux-gate/shared';
import { Pool } from 'pg';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5433/fluxgate'
});

const start = async () => {
    try {
        // Init DB
        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY,
                stock INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                product_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            -- Seed dummy product for testing if not exists
            INSERT INTO products (id, stock) VALUES ('iphone-15', 100) ON CONFLICT DO NOTHING;
        `);
        console.log("Database initialized.");

        const consumer = await createConsumer('inventory-group');
        await consumer.subscribe({ topic: 'orders', fromBeginning: true });

        console.log("Kafka Consumer connected. Listening...");

        await consumer.run({
            eachMessage: async ({ topic, partition, message }) => {
                const payload = JSON.parse(message.value?.toString() || '{}');
                const { orderId, productId, userId } = payload;

                console.log(`Processing order: ${orderId} for ${productId}`);

                // DB Transaction
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');

                    // Decrement DB stock (Safety net)
                    const res = await client.query(
                        'UPDATE products SET stock = stock - 1 WHERE id = $1 AND stock > 0',
                        [productId]
                    );

                    if (res.rowCount === 0) {
                        console.error(`SOLD OUT in DB for ${productId}! Data inconsistency detected (Redis allowed but DB failed).`);
                        // In a real app, trigger "Sold Out" email or reconciliation
                        await client.query('ROLLBACK');
                        return;
                    }

                    // Insert Order
                    await client.query(
                        'INSERT INTO orders (id, product_id, user_id) VALUES ($1, $2, $3)',
                        [orderId, productId, userId]
                    );

                    await client.query('COMMIT');
                    console.log(`Order ${orderId} persisted.`);
                } catch (e) {
                    await client.query('ROLLBACK');
                    console.error('Error processing order', e);
                    throw e; // Kafka will retry
                } finally {
                    client.release();
                }
            },
        });
    } catch (err) {
        console.error("Worker Error:", err);
    }
};

start();
