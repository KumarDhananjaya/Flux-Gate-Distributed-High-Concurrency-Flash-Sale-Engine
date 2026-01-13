# 🧠 Design Decisions

> Engineering judgment showcase: why we chose what we chose

This document explains the key architectural decisions in Flux-Gate, including rejected alternatives and future considerations.

---

## Decision Framework

Each decision follows this structure:
- **Context**: The problem we faced
- **Decision**: What we chose
- **Rationale**: Why this choice
- **Alternatives Rejected**: What we didn't choose and why
- **Consequences**: Trade-offs accepted

---

## 1. Redis Lua Script over Redlock

### Context
We need atomic inventory decrement at 100k+ operations per second without overselling.

### Decision
Use a **single Lua script** executing in Redis for atomic check-and-decrement.

```lua
local current = tonumber(redis.call('get', stockKey) or "0")
if current >= qty then
    redis.call('decrby', stockKey, qty)
    return 1  -- Success
else
    return 0  -- Sold out
end
```

### Rationale
- **Atomicity**: Lua scripts execute without interruption in Redis's single-threaded event loop
- **Latency**: Single round-trip (~1ms), no lock acquisition/release
- **Simplicity**: No distributed consensus needed

### Alternatives Rejected

| Alternative | Why Rejected |
|-------------|--------------|
| **Redlock** | 5+ round-trips for lock acquire/release; clock drift issues; too slow for flash sales |
| **Database Transactions** | 10-50ms latency, row-level locks cause contention at scale |
| **Optimistic Locking Only** | Race condition window too large for flash sale timing |
| **CAS (Compare-And-Swap)** | Retry storm under contention; Lua handles atomically |

### Consequences
- ✅ Zero overselling guaranteed
- ✅ Sub-millisecond operation
- ⚠️ Single Redis instance is SPOF (mitigate with Sentinel/Cluster)

---

## 2. Kafka over Direct Database Writes

### Context
At 100k RPS with 10-50ms per DB write, the database becomes the bottleneck. We needed to decouple ingestion from persistence.

### Decision
Use **Apache Kafka** as an intermediate buffer between API and database.

```
API → Kafka (1ms) → Worker → PostgreSQL (10-50ms)
```

### Rationale
- **Absorb spikes**: Kafka handles millions of messages/sec
- **Durability**: Messages persist to disk; survives crashes
- **Decoupling**: API latency independent of DB latency
- **Replay**: Can reprocess orders if needed

### Alternatives Rejected

| Alternative | Why Rejected |
|-------------|--------------|
| **Direct DB writes** | 10-50ms latency, connection pool exhaustion at scale |
| **RabbitMQ** | Lower throughput (~30k/sec), no built-in replay |
| **Amazon SQS** | ~3k msg/sec, not suitable for flash sale volume |
| **In-memory queue** | Not durable; data loss on crash |
| **Redis Streams** | Viable but Kafka's ecosystem is more mature for order processing |

### Consequences
- ✅ API responds in <10ms regardless of DB performance
- ✅ No data loss even if worker crashes
- ⚠️ Eventual consistency (order "accepted" before DB commit)
- ⚠️ Operational complexity of Kafka cluster

---

## 3. Token Bucket Rate Limiting

### Context
We need to protect downstream services from traffic spikes that exceed system capacity.

### Decision
Implement **token bucket algorithm** in Redis with HTTP 302 redirect to waiting room.

```typescript
const currentRate = await redis.incr(`rate:${Math.floor(Date.now()/1000)}`);
if (currentRate > THRESHOLD) {
    return reply.redirect(302, waitingRoom);
}
```

### Rationale
- **Fairness**: First-come-first-served within each second
- **Bursting**: Allows natural traffic variations
- **Graceful**: Users see waiting room, not errors
- **Zero overhead**: Single INCR per request

### Alternatives Rejected

| Alternative | Why Rejected |
|-------------|--------------|
| **Leaky Bucket** | Smooths traffic but adds latency; flash sales need fast-pass |
| **Fixed Window** | Boundary problem: 2x traffic allowed at window edge |
| **Sliding Window Log** | Memory overhead for tracking each request timestamp |
| **No Rate Limiting** | Would overwhelm Redis/Kafka/DB |
| **Queue-based** | Adds latency; users wait in queue vs immediate redirect |

### Consequences
- ✅ Downstream services never overwhelmed
- ✅ Legitimate traffic processed immediately
- ⚠️ Users above threshold must wait (better than crashes)

---

## 4. Idempotency Keys with TTL

### Context
Network issues cause retries. Double-clicking happens. We must not process the same order twice.

### Decision
Require **`x-idempotency-key` header** with 60-second TTL in Redis.

```typescript
if (!idempotencyKey) return error(400);
if (await redis.get(`idempotency:${key}`)) return cached;
// ... process ...
await redis.set(`idempotency:${key}`, '1', 'EX', 60);
```

### Rationale
- **Client control**: Client generates UUID, knows what's duplicate
- **Short TTL**: 60 seconds covers retry scenarios; doesn't waste memory
- **Fast check**: Redis lookup is O(1), ~1ms

### Alternatives Rejected

| Alternative | Why Rejected |
|-------------|--------------|
| **No idempotency** | Double-charges, overselling via duplicates |
| **Server-generated IDs** | Client can't safely retry; no duplicate detection |
| **Database unique constraint** | Too slow at scale, DB becomes bottleneck |
| **Long TTL (hours/days)** | Memory bloat; 60s is enough for retries |

### Consequences
- ✅ Safe retries without double-processing
- ⚠️ Client must generate and track idempotency keys
- ⚠️ After 60s TTL, same key could be reprocessed (acceptable for orders)

---

## 5. Optimistic Concurrency in PostgreSQL

### Context
Redis is the primary inventory control, but what if Redis fails or has stale data?

### Decision
Use **optimistic locking** as a safety net:

```sql
UPDATE products SET stock = stock - 1 
WHERE id = $1 AND stock > 0
```

### Rationale
- **Defense in depth**: Catches Redis-DB inconsistency
- **No extra round-trips**: Condition is part of UPDATE
- **Audit signal**: `rowCount = 0` indicates potential data issue

### Alternatives Rejected

| Alternative | Why Rejected |
|-------------|--------------|
| **Pessimistic locking (SELECT FOR UPDATE)** | Locks row, causes contention |
| **Trust Redis completely** | No safety net for data issues |
| **Version column** | Adds complexity; simple stock check is sufficient |

### Consequences
- ✅ Zero overselling even if Redis fails
- ✅ Detects and logs inconsistencies
- ⚠️ Slightly more complex error handling

---

## 6. Fastify over Express

### Context
Every millisecond matters at 100k RPS. Framework overhead adds up.

### Decision
Use **Fastify** for the ingestion API.

### Rationale
- **3x throughput**: 30k req/sec vs 10k req/sec
- **Lower latency**: p99 2ms vs 8ms
- **Schema validation**: Built-in JSON Schema for free validation
- **Plugin architecture**: Clean separation of concerns

### Alternatives Rejected

| Alternative | Why Rejected |
|-------------|--------------|
| **Express** | Known and familiar, but slower |
| **Koa** | Similar speed to Express, smaller ecosystem |
| **Hapi** | Feature-rich but heavier |
| **Raw Node.js** | Faster but sacrifices DX and maintainability |

### Consequences
- ✅ Higher throughput per instance
- ⚠️ Smaller community than Express (but growing)

---

## 7. Eventual Consistency Model

### Context
Strong consistency at 100k RPS is impossible without unacceptable latency.

### Decision
Accept **eventual consistency** between Redis and PostgreSQL.

```
User sees: "Order Accepted" (T+0)
Database has order: (T+100ms)
```

### Rationale
- **Speed**: Respond immediately, persist later
- **User experience**: Waiting for DB would add 50ms+ latency
- **Acceptable semantics**: "Accepted" ≠ "Completed"

### Alternatives Rejected

| Alternative | Why Rejected |
|-------------|--------------|
| **Strong consistency** | Synchronous DB writes too slow |
| **Two-phase commit** | Complex, slow, failure-prone |
| **Saga pattern** | Overkill for single inventory operation |

### Consequences
- ✅ Sub-10ms response times
- ⚠️ Order "accepted" before DB confirmation
- ⚠️ Requires clear user messaging ("Processing...")

---

## What Would Change at 1M RPS

| Component | Current | At 1M RPS |
|-----------|---------|-----------|
| **Redis** | Single instance | Redis Cluster with hash slots |
| **Kafka** | Single partition | Multiple partitions, partition-aware routing |
| **Ingestion API** | Single instance | Horizontal pods behind load balancer |
| **PostgreSQL** | Single write | Write replicas, read replicas, sharding |
| **Rate Limiter** | Per-second bucket | Distributed rate limiting (e.g., Envoy) |
| **Waiting Room** | Fastify static | CDN/Edge (CloudFront, Cloudflare) |
| **Monitoring** | Logs | Prometheus + Grafana + Jaeger tracing |

### Additional Considerations
- **Geographic distribution**: Multi-region for latency
- **Inventory sharding**: Per-product Redis clusters
- **Connection pooling**: PgBouncer for PostgreSQL
- **Exactly-once**: Kafka transactions for deduplication

---

## Summary

These decisions prioritize:
1. **Latency**: Sub-10ms response at any scale
2. **Correctness**: Zero overselling, guaranteed
3. **Resilience**: Graceful degradation, no data loss
4. **Simplicity**: Minimal moving parts for each guarantee

Each trade-off is intentional and documented.
