# 🏗️ Architecture

> Deep dive into Flux-Gate's distributed system design

---

## System Overview

Flux-Gate is an **event-driven microservices architecture** designed to handle extreme concurrency during flash sales. The core insight: **decouple request ingestion from order processing**.

```
                                    ┌─────────────────┐
                                    │  Waiting Room   │
                                    │   (Port 4000)   │
                                    └────────▲────────┘
                                             │ HTTP 302
                                             │ (Rate Limited)
┌──────────┐    POST /order    ┌─────────────┴──────────────┐
│          │──────────────────▶│      Ingestion API         │
│  Users   │                   │        (Fastify)           │
│  (100k+) │◀──────────────────│       Port 3000            │
└──────────┘   200/302/409     └──────────────┬─────────────┘
                                              │
                               ┌──────────────┼──────────────┐
                               │              │              │
                               ▼              ▼              ▼
                        ┌──────────┐   ┌───────────┐   ┌──────────┐
                        │  Redis   │   │  Redis    │   │  Kafka   │
                        │  Rate    │   │  Stock    │   │  Topic   │
                        │  Limiter │   │  Counter  │   │ "orders" │
                        └──────────┘   └───────────┘   └────┬─────┘
                                                            │
                                                            │ Consume
                                                            ▼
                                                    ┌───────────────┐
                                                    │   Inventory   │
                                                    │    Worker     │
                                                    └───────┬───────┘
                                                            │
                                                            │ INSERT/UPDATE
                                                            ▼
                                                    ┌───────────────┐
                                                    │  PostgreSQL   │
                                                    │   (Orders)    │
                                                    └───────────────┘
```

---

## Component Responsibilities

### 1. Ingestion API (`apps/ingestion-api`)

**Role**: High-speed request entry point. Never touches the database.

| Responsibility | Implementation |
|----------------|----------------|
| Rate Limiting | Token bucket in Redis (key: `rate:{timestamp}`) |
| Idempotency | Check Redis for `idempotency:{key}` before processing |
| Inventory Gate | Execute Lua script for atomic stock check/decrement |
| Async Handoff | Produce order message to Kafka topic |
| Response | Return immediately (< 10ms latency) |

```typescript
// Simplified flow
if (rateLimitExceeded) return redirect(302, waitingRoom);
if (duplicateRequest) return cached response;
if (!decrementStock()) return conflict(409, "Sold out");
await kafka.produce(orderMessage);
return ok(200, "Order accepted");
```

### 2. Redis (The Gatekeeper)

**Role**: In-memory state management with atomic guarantees.

| Key Pattern | Purpose | TTL |
|-------------|---------|-----|
| `rate:{unix_second}` | Request count per second | 2s |
| `product:{id}:stock` | Current inventory count | None |
| `idempotency:{uuid}` | Processed request marker | 60s |

**Critical**: Stock operations use Lua scripting for atomicity.

### 3. Kafka (The Buffer)

**Role**: Durable message queue that absorbs traffic spikes.

| Configuration | Value | Reason |
|---------------|-------|--------|
| Topic | `orders` | Single topic for all order events |
| Partitions | 1 (default) | Maintains strict ordering |
| Replication | 1 (dev) | Production would use 3 |

**Key Insight**: The API responds in milliseconds because it only needs Kafka acknowledgment, not database persistence.

### 4. Inventory Worker (`apps/inventory-worker`)

**Role**: Reliable order processing at sustainable pace.

| Responsibility | Implementation |
|----------------|----------------|
| Consume | Pull messages from `orders` topic |
| Validate | Double-check stock in PostgreSQL (safety net) |
| Persist | Transactional INSERT into `orders` table |
| Recover | On crash, resume from Kafka offset—no data loss |

### 5. PostgreSQL (System of Record)

**Role**: ACID-compliant permanent storage.

| Feature | Usage |
|---------|-------|
| Optimistic Locking | `UPDATE ... WHERE stock > 0` |
| Auto-generated Timestamps | `created_at DEFAULT CURRENT_TIMESTAMP` |
| Conflict Detection | Catches any Redis-DB inconsistency |

### 6. Waiting Room (`apps/waiting-room`)

**Role**: Absorb overflow traffic with minimal resources.

- Static HTML page served by Fastify Static
- Near-zero CPU/memory overhead
- Users retry automatically via JavaScript

---

## Technology Choice Rationale

### Why Redis Lua over Database Transactions?

| Factor | Redis Lua | DB Transaction |
|--------|-----------|----------------|
| Latency | ~1ms | 10-50ms |
| Lock Contention | None (single-threaded) | Row locks → deadlocks |
| Throughput | 100k+ ops/sec | ~1k TPS typical |
| Atomicity | Guaranteed (script execution) | Requires isolation level tuning |

**Decision**: Redis Lua provides sub-millisecond atomic operations without lock contention.

### Why Kafka over SQS / RabbitMQ?

| Factor | Kafka | SQS | RabbitMQ |
|--------|-------|-----|----------|
| Durability | Disk-backed, replayable | Ephemeral | Configurable |
| Ordering | Per-partition guaranteed | FIFO queues only | Not guaranteed |
| Throughput | Millions/sec | ~3k msg/sec | ~30k msg/sec |
| Consumer Recovery | Offset-based replay | At-most-once | Requires ack management |

**Decision**: Kafka's durability and replay capability are essential for order integrity.

### Why Fastify over Express?

| Benchmark | Fastify | Express |
|-----------|---------|---------|
| Requests/sec | 30,000+ | ~10,000 |
| Latency (p99) | 2ms | 8ms |
| JSON Serialization | Built-in fast-json-stringify | Manual |

**Decision**: At 100k RPS, every millisecond matters. Fastify's lower overhead is critical.

### Why Optimistic Locking in Database?

The database `UPDATE ... WHERE stock > 0` serves as a **safety net**, not the primary control:

1. **Primary Control**: Redis Lua script prevents overselling
2. **Safety Net**: DB check catches Redis failures or inconsistencies
3. **Audit Trail**: Failed DB updates log potential data issues

---

## Failure Modes

### Redis Down

| Impact | Mitigation |
|--------|------------|
| Rate limiting fails | All requests pass through |
| Stock checks fail | API returns 500 error |
| Orders blocked | System effectively down |

**Production Fix**: Redis Sentinel or Cluster for HA.

### Kafka Down

| Impact | Mitigation |
|--------|------------|
| Order production fails | Stock decremented but order not queued |
| Potential inconsistency | Log error, require manual reconciliation |

**Production Fix**: Multi-broker Kafka cluster, producer retries.

### Worker Crash

| Impact | Mitigation |
|--------|------------|
| Order processing stops | Messages accumulate in Kafka |
| No data loss | Kafka retains messages |
| Recovery | Restart worker, resumes from last offset |

**This is the safest failure mode**—demonstrates system resilience.

---

## Back-Pressure Strategy

### Token Bucket Rate Limiting

```
Incoming Request
      │
      ▼
┌─────────────────────────────────┐
│ INCR rate:{current_second}      │
│                                 │
│ if count > THRESHOLD (50):      │
│   → HTTP 302 to Waiting Room    │
│ else:                           │
│   → Continue processing         │
└─────────────────────────────────┘
```

**Configuration**:
- Threshold: 50/sec (demo), 10,000/sec (production)
- Window: 1 second
- Key TTL: 2 seconds (cleanup)

### Why This Works

1. **Protects downstream services**: Redis, Kafka, DB never overwhelmed
2. **Graceful degradation**: Users see waiting room, not errors
3. **Fair queuing**: Token bucket allows bursts within capacity
4. **Near-zero overhead**: Single Redis INCR per request

---

## Data Consistency Model

### Eventual Consistency

Flux-Gate uses **eventual consistency** between Redis and PostgreSQL:

```
Timeline:
─────────────────────────────────────────────────────────────────▶

T0: Redis stock = 100
T1: User A request → Redis stock = 99, Kafka message produced
T2: API returns 200 "Order Accepted" to User A
T3: [... ~10-100ms later ...]
T4: Worker consumes message, PostgreSQL order inserted

During T2-T4: Redis and PostgreSQL are inconsistent
After T4: Both systems consistent
```

### Guarantees

| Property | Guaranteed? | Notes |
|----------|-------------|-------|
| No Overselling | ✅ Yes | Redis Lua is atomic |
| Order Eventually Persisted | ✅ Yes | Kafka durability |
| Immediate DB Confirmation | ❌ No | User gets "Accepted", not "Completed" |
| Exact Inventory Sync | ❌ No | Redis leads, DB follows |

### Why This Trade-off?

At 100k RPS, **strong consistency is impossible** without:
- Distributed locks (too slow)
- Two-phase commit (too complex)
- Synchronous DB writes (too slow)

Eventual consistency gives us **speed with guarantees that matter** (no overselling, no data loss).

---

## Related Documentation

- [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md) - Detailed reasoning for each choice
- [FAILURE_MODES.md](./FAILURE_MODES.md) - Comprehensive failure analysis
- [SCALING.md](./SCALING.md) - Horizontal scaling strategies
