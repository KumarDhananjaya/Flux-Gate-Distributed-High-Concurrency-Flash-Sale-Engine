# Interview Preparation Guide - Flux-Gate

This guide contains the most critical system design and distributed systems questions related to the Flux-Gate project.

---

## 1. Core Architecture & Design

### Q1: What is the main problem Flux-Gate solves?
**A**: It solves the "Flash Sale" problem: handling massive bursts of traffic (Thundering Herd) while ensuring **zero overselling**, **fairness**, and **high availability** of the system.

### Q2: Why use an event-driven architecture instead of a simple API-to-DB flow?
**A**: A direct DB write takes ~10-100ms. At 100k RPS, the database connections will be exhausted instantly, and the DB will crash. By using Kafka as a buffer, the API can respond in <1ms, and the worker processes the backlog at a sustainable pace.

### Q3: What is the role of the "Gatekeeper" in this system?
**A**: The Gatekeeper (Redis + Ingestion API) acts as a high-speed filter. It decides instantly if a request should proceed (stock available) or be rejected (sold out/rate limited) without touching any slow disk-based storage.

---

## 2. Concurrency & Atomicity

### Q4: How do you ensure you don't sell 101 items when you only have 100 in stock?
**A**: We use **Redis Lua Scripts**. Since Redis is single-threaded for command execution, the script `GET stock -> IF stock > 0 -> DECR stock` runs as a single atomic operation. No other request can "sneak in" between the check and the decrement.

### Q5: Why not use Database Transactions (SELECT FOR UPDATE) for inventory?
**A**: Relational database locks are heavy and don't scale well across multiple app nodes under extreme concurrency. Redis handles these operations entirely in-memory with sub-millisecond latency.

### Q6: What happens if the Ingestion API crashes after decrementing Redis but before sending to Kafka?
**A**: This is a "Distributed Transaction" problem. In the current implementation, we might lose a sale (stock decremented but no order created). In a production system, we would use a **Transactional Outbox Pattern** or a **Two-Phase Commit**, but for a flash sale, a slight "under-sell" is safer than an "over-sell".

---

## 3. Scalability & Resilience

### Q7: How do you handle 1,000,000 users hitting the site at once?
**A**: We use a **Virtual Waiting Room**. When traffic exceeds a threshold (e.g., 10k RPS), we redirect excess users to a static HTML page. This keeps the core infrastructure alive for the lucky users who "made it through the gate."

### Q8: What is Idempotency and why is it needed here?
**A**: Idempotency ensures that if a user clicks "Buy" twice (or their network retries the request), only **one** item is sold. We use a unique `x-idempotency-key` stored in Redis with a TTL to track and ignore duplicate requests.

### Q9: If the Inventory Worker is slow, will the system crash?
**A**: No. Kafka will simply buffer the messages. The Ingestion API will continue accepting orders as long as Redis has stock and Kafka has disk space. This is "Temporal Decoupling."

---

## 4. Technology Specifics

### Q10: Why use Kafka instead of RabbitMQ?
**A**: Kafka is designed for high-throughput log-append operations and can handle massive bursts of messages better than RabbitMQ. It also allows for "replayability" if the database needs to be recovered.

### Q11: Why use Fastify instead of Express?
**A**: Fastify has lower overhead and is significantly faster at parsing JSON, which is critical when every microsecond counts during a flash sale.

---

## 5. Advanced Scenarios

### Q12: How would you handle a distributed Redis setup?
**A**: Use **Redis Cluster** and ensure the `productId` is part of the "hash tag" (e.g., `{product:123}:stock`) so all operations for the same product happen on the same shard, allowing Lua scripts to remain atomic.

### Q13: How do you prevent "Bots" from clearing the inventory?
**A**: Implement **Advanced Rate Limiting** using IP-based quotas or CAPTCHA integration at the Load Balancer level (e.g., Cloudflare) before the request even reaches the Ingestion API.

### Q14: What is the "Thundering Herd" problem?
**A**: It's when a large number of clients wait for an event (like a sale start) and then all hit the server at the exact same millisecond. We mitigate this with a Global Rate Limiter and the Waiting Room.
