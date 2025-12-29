# System Design Deep Dive - Flux-Gate

## 1. Handling the "Thundering Herd" Problem
The "Thundering Herd" occurs when a massive number of clients wait for a specific event (e.g., a countdown to 12:00 PM) and all initiate requests at the exact same moment.

### Mitigation Strategies in Flux-Gate:
- **Rate Limiting at the Edge**: The system uses a high-speed rate limiter in Redis. Instead of processing 100k requests that would fail eventually, we reject or redirect 90k of them in milliseconds, preserving the system's "vital organs" (DB and Workers).
- **Asymmetric Loading**: By serving the countdown on a CDN-cached static page, we prevent any load on the application server until the actual request is made.
- **Micro-Queuing**: The Ingestion API uses Fastify's internal queuing and Kafka's buffering to smooth out the traffic spike over time.

---

## 2. Virtual Waiting Room (VWR) Mechanics
The VWR is a critical safety valve. It transforms a potential "System Down" scenario into a "Degraded but Stable" one.

### How it works:
1. **Detection**: Each incoming request increments a `current_rps` counter in Redis.
2. **Action**: If `current_rps > THRESHOLD`, the Ingestion API returns a `302 Redirect` to `http://waiting-room-url/`.
3. **User Experience**: The user sees a lightweight static page with a "Please wait" message and perhaps an auto-retry mechanism.
4. **Benefit**: The core API only processes what it can handle. The "Waiting Room" is served from a static file server (or CDN), which can handle millions of requests with almost zero CPU overhead.

---

## 3. Atomic Decrement vs. Distributed Locking
In high-concurrency scenarios, performance is king.

- **Distributed Locks (e.g., Redlock)**: Require multiple round-trips to valid signatures and handle timeouts. Under heavy load, the lock management itself can become the bottleneck.
- **Lua Scripts (Flux-Gate Approach)**: Single round-trip. The logic is executed locally on the Redis server. It is 10-50x faster than traditional distributed locking and perfectly safe due to Redis's single-threaded execution model.

---

## 4. Idempotency Keys (The "Double Click" Problem)
A flash sale environment is prone to network glitches. A user might click "Buy," the request succeeds, but the connection drops before the user gets the confirmation. The user clicks "Buy" again.

### Implementation:
1. Client generates a UUID (`idempotency-key`) before sending the request.
2. Ingestion API checks Redis: `EXISTS idempotency:<key>`.
3. If it exists, return the cached successful response.
4. If not, proceed with the sale and then save the key with a TTL (e.g., 60 seconds).
5. This ensures that even if 100 requests arrive for the same user-click, only 1 decrement happens in Redis.

---

## 5. Chaos Engineering & Resilience
How does Flux-Gate survive failures?

- **Worker Failure**: If the Inventory Worker dies, messages stay safe in Kafka. Once the worker restarts, it resumes from the last committed offset. User orders are delayed but never lost.
- **Redis Primary Failure**: If Redis fails, the system enters a "Fail-Closed" state (sales stop) to prevent overselling. In a production environment, Redis Sentinel or Cluster would handle an automatic failover to a replica.
- **DB Pressure**: Kafka acts as a shock absorber. We can scale the number of Inventory Workers (up to the number of Kafka partitions) to increase DB throughput without manual intervention.
