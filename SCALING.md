# 📈 Scaling Strategy

> How Flux-Gate scales horizontally and when this design breaks

---

## Current Architecture (Demo Scale)

| Component | Instances | Capacity |
|-----------|-----------|----------|
| Ingestion API | 1 | ~6,000 RPS local |
| Redis | 1 | 100k+ ops/sec |
| Kafka | 1 broker, 1 partition | 1M+ msg/sec |
| Worker | 1 | ~1,000 orders/sec |
| PostgreSQL | 1 | ~1,000 TPS |

---

## Horizontal Scaling Strategy

### 1. Ingestion API

**Current**: Single Fastify instance
**Scaling**: Stateless, horizontally scalable

```
┌─────────────────┐
│  Load Balancer  │
│  (nginx/k8s)    │
└────────┬────────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
┌─────┐┌─────┐┌─────┐
│API 1││API 2││API N│
└─────┘└─────┘└─────┘
    │    │    │
    └────┼────┘
         ▼
      ┌────────┐
      │ Redis  │
      └────────┘
```

**Requirements**:
- Sticky sessions NOT required (stateless)
- Health checks on `/health` endpoint
- Docker/Kubernetes deployment

**Scaling triggers**:
- CPU > 70%
- Latency p99 > 50ms
- Memory > 80%

### 2. Redis

**Current**: Single instance
**Scaling Options**:

| Option | Use Case | Complexity |
|--------|----------|------------|
| **Redis Sentinel** | High availability | Medium |
| **Redis Cluster** | Sharding + HA | High |
| **Elasticache** | Managed, auto-scaling | Low |

**Redis Cluster Sharding**:
```
Hash slots: 0-16383
product:iphone-15:stock → slot 12487 → Node 3
product:ps5-disc:stock  → slot 8921  → Node 2
```

**Considerations**:
- Lua scripts run on single node (must use same slot for related keys)
- Rate limiting keys: Use same timestamp across cluster
- Idempotency keys: Already distributed by UUID

### 3. Kafka

**Current**: 1 partition
**Scaling**: Multiple partitions with partition-aware routing

```
Topic: orders
├── Partition 0: productId.hashCode() % 3 == 0
├── Partition 1: productId.hashCode() % 3 == 1
└── Partition 2: productId.hashCode() % 3 == 2
```

**Benefits**:
- Parallel consumption (1 consumer per partition)
- Ordering preserved per product
- Higher throughput

**Producer change**:
```typescript
await producer.send({
    topic: 'orders',
    messages: [{
        key: productId,  // Partition by product
        value: JSON.stringify(order)
    }]
});
```

### 4. Inventory Worker

**Current**: Single consumer
**Scaling**: Consumer group with partition assignment

```
┌────────────────────────┐
│  Kafka Consumer Group  │
│   "inventory-group"    │
├────────────────────────┤
│ Worker 1 ← Partition 0 │
│ Worker 2 ← Partition 1 │
│ Worker 3 ← Partition 2 │
└────────────────────────┘
```

**Properties**:
- Max workers = number of partitions
- Automatic rebalancing on worker failure
- At-least-once delivery

### 5. PostgreSQL

**Current**: Single write instance
**Scaling Options**:

| Strategy | Read/Write | Complexity |
|----------|------------|------------|
| **Read Replicas** | Scale reads | Low |
| **PgBouncer** | Connection pooling | Low |
| **Citus** | Horizontal sharding | High |
| **Vitess** | Distributed MySQL | High |

**Read/Write Split**:
```
Writes → Primary (orders table)
Reads  → Replica (analytics, reporting)
```

**Connection Pooling**:
```
Workers → PgBouncer (50 connections) → PostgreSQL (500 backend)
```

---

## Bottleneck Analysis

### At 10k RPS

| Component | Bottleneck? | Status |
|-----------|-------------|--------|
| API | No | Scale to 3 instances |
| Redis | No | Single instance handles it |
| Kafka | No | Single partition sufficient |
| Worker | Maybe | May need 2-3 workers |
| PostgreSQL | Maybe | Consider connection pooling |

### At 100k RPS

| Component | Bottleneck? | Solution |
|-----------|-------------|----------|
| API | No | 10+ instances behind LB |
| Redis | Maybe | Redis Cluster (3 masters) |
| Kafka | No | 10 partitions |
| Worker | Yes | 10 workers + batch processing |
| PostgreSQL | Yes | Sharding or write batching |

### At 1M RPS

| Component | Bottleneck? | Solution |
|-----------|-------------|----------|
| API | No | 100+ pods, geo-distributed |
| Redis | Yes | Partitioned by product ranges |
| Kafka | No | 100 partitions |
| Worker | Yes | 100 workers + parallel batch |
| PostgreSQL | Yes | Shard by product ID, Citus |

---

## When This Design Breaks

### Fundamental Limits

| Limit | Threshold | Symptom |
|-------|-----------|---------|
| **Single Redis key** | ~1M ops/sec | Hot key contention |
| **Kafka partition** | ~500k msg/sec | Consumer lag |
| **PostgreSQL row** | ~10k updates/sec | Lock contention |

### Hot Key Problem

When a single product (e.g., iPhone launch) gets 1M RPS:
- All requests hit same Redis key
- Solution: Inventory buckets

```lua
-- Instead of: product:iphone:stock = 1000
-- Use: product:iphone:bucket:{0-9} = 100 each
-- Random bucket selection distributes load
```

### Cross-Region Orders

Current design assumes single region. For global:
- Each region needs its own Redis + Kafka
- Inventory allocation per region
- Cross-region coordination (complex)

---

## Cost vs Performance Trade-offs

### Low Cost (Current Demo)

| Component | Setup | Monthly Cost |
|-----------|-------|--------------|
| API | 1 container | $5-20 |
| Redis | t3.micro | $10 |
| Kafka | MSK small | $50 |
| PostgreSQL | db.t3.micro | $15 |
| **Total** | | **~$100** |

### Medium Scale (10k RPS)

| Component | Setup | Monthly Cost |
|-----------|-------|--------------|
| API | 5 containers | $100 |
| Redis | r6g.large | $150 |
| Kafka | MSK medium | $200 |
| PostgreSQL | db.r6g.large | $200 |
| **Total** | | **~$650** |

### High Scale (100k RPS)

| Component | Setup | Monthly Cost |
|-----------|-------|--------------|
| API | 20 containers | $400 |
| Redis | Cluster (3 nodes) | $500 |
| Kafka | MSK large | $500 |
| PostgreSQL | db.r6g.xl + replica | $600 |
| Load balancer | | $150 |
| **Total** | | **~$2,150** |

---

## Scaling Runbook

### When to Scale API

```bash
# Check current metrics
kubectl top pods -l app=ingestion-api

# Scale up
kubectl scale deployment ingestion-api --replicas=5

# Auto-scaling (HPA)
kubectl autoscale deployment ingestion-api \
  --cpu-percent=70 \
  --min=2 \
  --max=20
```

### When to Scale Workers

```bash
# Check consumer lag
kafka-consumer-groups.sh --describe --group inventory-group

# If lag > 10k messages, scale up
kubectl scale deployment inventory-worker --replicas=3
```

### When to Scale Redis

Monitor:
- Memory usage > 80% → Add node
- Latency > 1ms → Add node
- CPU > 70% → Add node

---

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - Component details
- [FAILURE_MODES.md](./FAILURE_MODES.md) - Failure scenarios
- [LOAD_TESTING.md](./LOAD_TESTING.md) - Performance benchmarks
