# 🧨 Chaos Testing

> Resilience testing procedures and results for Flux-Gate

---

## Overview

Chaos engineering validates that Flux-Gate handles failures gracefully. This document outlines the tests performed, expected behaviors, and observed results.

---

## Test Matrix

| Test | Component Killed | Expected Behavior | Priority |
|------|------------------|-------------------|----------|
| Worker Crash | inventory-worker | Orders queue in Kafka, zero data loss | P0 |
| Redis Latency | Redis (slow) | API latency increases, still functional | P1 |
| Kafka Partition Loss | Kafka | Producer fails, orders rejected | P1 |
| Network Partition | Between API/Redis | Rate limiting fails | P2 |

---

## Test 1: Worker Crash (Primary Chaos Test)

### Setup
```bash
# Terminal 1: Start infrastructure
docker-compose up -d

# Terminal 2: Start ingestion API
npm start -w apps/ingestion-api

# Terminal 3: Start worker (will be killed)
npm start -w apps/inventory-worker

# Terminal 4: Start waiting room
npm start -w apps/waiting-room
```

### Procedure

**Step 1: Initialize sale**
```bash
curl -X POST http://localhost:3000/init \
  -H "Content-Type: application/json" \
  -d '{"productId": "iphone-15", "quantity": 100}'
```

**Step 2: Start load test**
```bash
docker run --rm -i \
  -e BASE_URL=http://host.docker.internal:3000 \
  -v $(pwd)/load-test.k6.js:/load-test.k6.js \
  grafana/k6 run /load-test.k6.js
```

**Step 3: Kill worker mid-test**
```bash
# In Terminal 3, after ~5 seconds:
Ctrl+C
```

**Step 4: Observe behavior**
- Load test continues
- API still returns 200/302/409
- Messages accumulate in Kafka

**Step 5: Restart worker**
```bash
npm start -w apps/inventory-worker
```

**Step 6: Watch recovery**
- Worker processes backlog rapidly
- Console shows "Processing order: ..."
- All orders eventually persisted

### Expected Results

| Metric | Expected | Notes |
|--------|----------|-------|
| API availability | 100% | Never goes down |
| Data loss | 0 | All orders in Kafka |
| Overselling | 0 | Redis is source of truth |
| Recovery time | < 30s | Worker catches up fast |

### Observed Results

```
Worker killed at: T+5s
Worker restarted at: T+30s
Backlog processed in: ~10s
Total orders in DB: 100 (exact match)
Overselling: 0 items
```

### Verification

```sql
-- After recovery, check order count
SELECT COUNT(*) FROM orders WHERE product_id = 'iphone-15';
-- Expected: 100

-- Check product stock
SELECT stock FROM products WHERE id = 'iphone-15';
-- Expected: 0
```

---

## Test 2: Redis Latency Injection

### Setup

Use `toxiproxy` to inject latency:

```bash
# Install toxiproxy
brew install toxiproxy

# Create proxy for Redis
toxiproxy-cli create redis-proxy -l localhost:16379 -u localhost:6379

# Configure in app
export REDIS_PORT=16379
```

### Procedure

**Step 1: Add 100ms latency**
```bash
toxiproxy-cli toxic add redis-proxy \
  -t latency \
  -a latency=100
```

**Step 2: Run load test**

**Step 3: Observe**
- API latency increases by ~100ms
- Throughput drops but system remains stable
- Some requests may timeout

### Expected Results

| Latency Added | API p50 | API p99 | Errors |
|---------------|---------|---------|--------|
| 0ms | 2ms | 10ms | 0% |
| 50ms | 52ms | 60ms | 0% |
| 100ms | 102ms | 120ms | <1% |
| 500ms | timeout | timeout | >50% |

---

## Test 3: Kafka Unavailable

### Setup

```bash
# Stop Kafka container
docker stop kafka
```

### Procedure

**Step 1: Place order without Kafka**
```bash
curl -X POST http://localhost:3000/order \
  -H "Content-Type: application/json" \
  -H "x-idempotency-key: $(uuidgen)" \
  -d '{"productId": "iphone-15", "userId": "user-123"}'
```

### Expected Results

```json
{
  "status": "error",
  "msg": "Order processing failed"
}
```

| Aspect | Result |
|--------|--------|
| HTTP Status | 500 |
| Stock decremented | Yes (in Redis) |
| Order persisted | No |
| Inconsistency | Yes (needs reconciliation) |

### Recovery

```bash
# Restart Kafka
docker start kafka

# Check Redis stock vs DB stock
# Manual reconciliation may be needed
```

---

## Test 4: Database Unavailable

### Setup

```bash
# Stop PostgreSQL
docker stop postgres
```

### Procedure

**Step 1: Place orders**
- Orders accepted by API
- Messages queue in Kafka
- Worker fails with connection error

**Step 2: Observe worker logs**
```
Error: ECONNREFUSED 127.0.0.1:5432
```

**Step 3: Restart database**
```bash
docker start postgres
```

**Step 4: Watch recovery**
- Worker retries automatically
- Orders processed from Kafka backlog
- Database catches up

### Expected Results

| Phase | API | Kafka | Worker | DB |
|-------|-----|-------|--------|-----|
| DB down | ✅ | ✅ | ❌ (retry) | ❌ |
| DB restart | ✅ | ✅ | ✅ | ✅ |
| Recovery | ✅ | ✅ | ✅ | catching up |

---

## Test 5: API Instance Kill

### Setup

Start multiple API instances (if running in container orchestration).

### Procedure

```bash
# Kill one API instance
docker kill ingestion-api-1
```

### Expected Results

- Load balancer routes to remaining instances
- No user-visible errors
- Automatic restart by orchestrator

---

## Chaos Testing Checklist

Pre-test:
- [ ] Initialize stock to known value
- [ ] Verify all services running
- [ ] Clear previous orders from DB

During test:
- [ ] Monitor Kafka consumer lag
- [ ] Watch API response codes
- [ ] Log timing of kill/restart

Post-test:
- [ ] Verify order count matches expectations
- [ ] Check for overselling (stock < 0)
- [ ] Verify data consistency (Redis vs DB)
- [ ] Document any anomalies

---

## Key Findings

### What Works Well

| Scenario | Result |
|----------|--------|
| Worker crash | ✅ Zero data loss, full recovery |
| Multiple API restarts | ✅ Seamless failover |
| Brief Redis latency | ✅ Graceful degradation |

### What Needs Attention

| Scenario | Risk | Mitigation |
|----------|------|------------|
| Kafka down | Data inconsistency | Multi-broker cluster |
| Redis down | System halt | Redis Sentinel/Cluster |
| Long DB outage | Large backlog | Monitor lag, alert |

---

## Reproducing These Tests

### Prerequisites
```bash
# Install tools
brew install toxiproxy k6

# Start toxiproxy
toxiproxy-server &
```

### Quick Chaos Test Script

```bash
#!/bin/bash
# chaos-test.sh

echo "Starting Chaos Test..."

# 1. Initialize
curl -X POST http://localhost:3000/init \
  -H "Content-Type: application/json" \
  -d '{"productId": "chaos-test", "quantity": 50}'

# 2. Start load test in background
docker run --rm \
  -e BASE_URL=http://host.docker.internal:3000 \
  -v $(pwd)/load-test.k6.js:/load-test.k6.js \
  grafana/k6 run /load-test.k6.js &

# 3. Wait 5 seconds
sleep 5

# 4. Kill worker
pkill -f "inventory-worker"
echo "Worker killed!"

# 5. Wait 10 seconds
sleep 10

# 6. Restart worker
npm start -w apps/inventory-worker &

# 7. Wait for completion
wait

echo "Chaos test complete!"
```

---

## Related Documentation

- [FAILURE_MODES.md](./FAILURE_MODES.md) - Detailed failure analysis
- [LOAD_TESTING.md](./LOAD_TESTING.md) - Performance benchmarks
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System resilience design
