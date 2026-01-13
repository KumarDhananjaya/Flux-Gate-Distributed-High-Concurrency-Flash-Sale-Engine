# 💥 Failure Modes

> Comprehensive analysis of how Flux-Gate fails and recovers

---

## Failure Mode Summary

| Component | Impact | Detection | Recovery |
|-----------|--------|-----------|----------|
| Redis Down | System halts | Health check | Restart + reinit from DB |
| Kafka Down | Orders not queued | Producer exception | Retry with backoff |
| Worker Crash | Processing stops | Consumer lag | Restart, resume from offset |
| PostgreSQL Down | Orders not persisted | Connection error | Wait for DB recovery |
| API Crash | No new requests | LB health check | Restart, stateless |

---

## 1. Redis Failure

### Scenario: Redis Instance Down

**Detection**:
```
Error: ECONNREFUSED 127.0.0.1:6379
```

**Impact**:
| Function | Status | User Experience |
|----------|--------|-----------------|
| Rate limiting | ❌ Broken | All requests pass or fail |
| Stock check | ❌ Broken | 500 errors |
| Idempotency | ❌ Broken | Duplicates possible |
| **Overall** | ❌ Down | System unusable |

**Recovery Steps**:
1. Alert triggers (connection refused)
2. Restart Redis instance
3. Re-initialize stock from PostgreSQL:
```sql
SELECT id, stock FROM products WHERE stock > 0;
-- For each: SET product:{id}:stock {value}
```
4. Resume operations

**Prevention**:
- Redis Sentinel for automatic failover
- Redis Cluster for no SPOF
- Health monitoring with alerting

### Scenario: Redis Memory Full

**Detection**:
```
OOM command not allowed when used memory > 'maxmemory'
```

**Impact**:
- New idempotency keys rejected
- Rate limit keys may fail
- Stock operations may fail

**Recovery**:
1. Increase maxmemory or add nodes
2. Review key TTLs
3. Flush idempotency keys if safe

---

## 2. Kafka Failure

### Scenario: Kafka Broker Down

**Detection**:
```
KafkaJSError: Request timed out
```

**Impact**:
| Operation | Status |
|-----------|--------|
| Stock decremented | ✅ Completed |
| Order queued | ❌ Failed |
| DB persisted | ❌ Not reached |
| **User sees** | 500 error |

**Data Inconsistency**:
- Redis: stock decremented by 1
- Kafka: message not produced
- PostgreSQL: no order record

**Recovery**:
1. Log the failed order for reconciliation
2. Either:
   - Retry producing to Kafka (preferred)
   - Roll back Redis stock (complex)
3. Alert for manual review

**Code behavior**:
```typescript
try {
    await producer.send({ topic: 'orders', messages: [order] });
} catch (error) {
    // Stock already decremented!
    fastify.log.error({ err: error }, 'Kafka failed');
    return reply.code(500).send({ 
        status: 'error', 
        msg: 'Order processing failed' 
    });
}
```

**Prevention**:
- Multi-broker Kafka cluster (replication factor 3)
- Producer retries with idempotent producer
- Circuit breaker pattern

### Scenario: Kafka Lag Buildup

**Detection**:
```
Consumer lag for group 'inventory-group': 50000 messages
```

**Impact**:
- Orders accepted but not persisted
- Users think order complete, DB says no
- Potential customer complaints

**Recovery**:
1. Scale up workers
2. Increase batch size if safe
3. Monitor until lag = 0

**Monitoring**:
```bash
# Check lag
kafka-consumer-groups.sh \
  --bootstrap-server localhost:9093 \
  --describe \
  --group inventory-group
```

---

## 3. Worker Failure

### Scenario: Worker Crashes Mid-Processing

**Detection**:
```
Worker process exited unexpectedly
```

**Impact**:
| State | Status |
|-------|--------|
| Kafka messages | ✅ Safe (not committed) |
| In-flight order | 🔄 Will be reprocessed |
| PostgreSQL | No impact |

**This is the safest failure mode!**

**Recovery**:
1. Worker restarts (automatically via Docker/K8s)
2. Kafka rebalances partitions
3. Worker resumes from last committed offset
4. Order reprocessed (idempotent INSERT)

**Why it works**:
- Kafka commits offset AFTER successful processing
- Uncommitted messages are replayed
- Database INSERT is idempotent (same orderId)

**Timeline**:
```
T0: Worker pulls message (offset 1000)
T1: BEGIN transaction
T2: UPDATE products... 
T3: CRASH!
-- Message NOT committed --
T4: Worker restarts
T5: Worker pulls message 1000 again
T6: Processes successfully
T7: Commits offset 1000
```

### Scenario: Worker OOM

**Detection**:
```
Container killed: OOMKilled
```

**Impact**: Same as crash (safe)

**Prevention**:
- Set memory limits appropriately
- Monitor memory usage
- Batch processing with reasonable batch size

---

## 4. PostgreSQL Failure

### Scenario: Database Down

**Detection**:
```
Error: ECONNREFUSED 127.0.0.1:5432
```

**Impact**:
| Component | Status |
|-----------|--------|
| Ingestion API | ✅ Continues accepting |
| Redis | ✅ Continues decrementing |
| Kafka | ✅ Continues queuing |
| Worker | ❌ Fails to persist |

**User Experience**: 
- New orders accepted (200 OK)
- Confirmation: "Order accepted"
- But order not in database

**Recovery**:
1. Database comes back online
2. Worker retries failed operations
3. Orders eventually persisted

**Worker behavior**:
```typescript
try {
    await client.query('INSERT INTO orders...');
    await client.query('COMMIT');
} catch (e) {
    await client.query('ROLLBACK');
    throw e;  // Kafka will retry
}
```

### Scenario: Database Connection Pool Exhausted

**Detection**:
```
TimeoutError: Connection pool exhausted
```

**Impact**: Workers fail to process

**Prevention**:
- Right-size connection pool
- Use PgBouncer
- Monitor active connections

---

## 5. Ingestion API Failure

### Scenario: API Container Crashes

**Detection**: Load balancer health check fails

**Impact**:
- That instance stops serving
- Other instances continue
- No data loss (stateless)

**Recovery**: Automatic restart by orchestrator

**Prevention**:
- Multiple instances behind LB
- Kubernetes deployment with replicas
- Graceful shutdown handling

---

## Data Consistency Scenarios

### Scenario: Redis-PostgreSQL Mismatch

**How it happens**:
1. Redis stock = 99 (decremented)
2. Kafka message produced
3. Worker crashes before DB commit
4. Worker restarts, processes message
5. But: `UPDATE ... WHERE stock > 0` fails!

**Detection**:
```
SOLD OUT in DB for iphone-15! Data inconsistency detected.
```

**Resolution**:
1. Log incident for investigation
2. Check Redis vs DB values
3. Reconcile manually if needed:
```sql
-- Trust PostgreSQL
UPDATE products SET stock = (SELECT COUNT(*) FROM orders WHERE product_id = 'iphone-15');
-- Sync Redis
SET product:iphone-15:stock {correct_value}
```

### At-Least-Once vs Exactly-Once

**Current**: At-least-once delivery

| Guarantee | Status | Notes |
|-----------|--------|-------|
| At-least-once | ✅ Yes | Kafka replays on failure |
| Exactly-once | ⚠️ Application | Idempotent INSERTs |
| No message loss | ✅ Yes | Kafka durability |

**Exactly-once would require**:
- Kafka transactions
- Transactional outbox pattern
- Significantly more complexity

---

## Monitoring & Alerting

### Key Metrics to Watch

| Metric | Warning | Critical |
|--------|---------|----------|
| Redis latency | > 5ms | > 20ms |
| Kafka consumer lag | > 1000 | > 10000 |
| API error rate | > 1% | > 5% |
| DB connection pool | > 80% | > 95% |
| Worker processing rate | < 500/s | < 100/s |

### Alert Examples

```yaml
# Prometheus alert
- alert: KafkaConsumerLag
  expr: kafka_consumer_lag > 10000
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Consumer lag critical"
    
- alert: RedisDown
  expr: redis_up == 0
  for: 30s
  labels:
    severity: critical
```

---

## Failure Recovery Matrix

| Failure | Data Loss? | Auto-Recover? | Manual Action? |
|---------|------------|---------------|----------------|
| Redis down | No | No | Restart + reinit |
| Kafka down | Possible | Partial | Review logs |
| Worker crash | No | Yes | None |
| DB down | No | Yes | Wait |
| API crash | No | Yes | None |
| Network partition | Possible | Partial | Investigate |

---

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - System design
- [CHAOS_TESTING.md](./CHAOS_TESTING.md) - Testing these scenarios
- [SCALING.md](./SCALING.md) - Preventing failures via scaling
