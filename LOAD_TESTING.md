# 📊 Load Testing

> Performance benchmarks and k6 test configuration for Flux-Gate

---

## Overview

We use **k6** by Grafana Labs for load testing. k6 is scriptable, produces real-time metrics, and runs easily via Docker.

---

## Test Configuration

### k6 Script: `load-test.k6.js`

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
    scenarios: {
        flash_sale: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '10s', target: 50 },   // Ramp up
                { duration: '10s', target: 100 },  // Peak load
                { duration: '5s', target: 0 },     // Ramp down
            ],
            gracefulRampDown: '0s',
        },
    },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export function setup() {
    // Initialize 100 items
    const payload = JSON.stringify({
        productId: 'iphone-15',
        quantity: 100
    });
    http.post(`${BASE_URL}/init`, payload, {
        headers: { 'Content-Type': 'application/json' }
    });
}

export default function () {
    const payload = JSON.stringify({
        productId: 'iphone-15',
        userId: uuidv4(),
    });

    const params = {
        redirects: 0,  // Don't follow 302
        headers: {
            'Content-Type': 'application/json',
            'x-idempotency-key': uuidv4(),
        },
    };

    const res = http.post(`${BASE_URL}/order`, payload, params);
    
    check(res, {
        'valid response': (r) => [200, 302, 409].includes(r.status),
    });
}
```

### Traffic Shape

```
VUs
100 |          ████████
 75 |       ███        
 50 |    ███           ███
 25 | ███                  ███
  0 |__________________________|
    0   10s    20s    25s
        Time →
```

---

## Running Load Tests

### Prerequisites

```bash
# Start infrastructure
docker-compose up -d

# Start all services
npm start -w apps/ingestion-api &
npm start -w apps/inventory-worker &
npm start -w apps/waiting-room &
```

### Initialize Sale

```bash
curl -X POST http://localhost:3000/init \
  -H "Content-Type: application/json" \
  -d '{"productId": "iphone-15", "quantity": 100}'
```

### Run k6 (Docker)

```bash
docker run --rm -i \
  -e BASE_URL=http://host.docker.internal:3000 \
  -v $(pwd)/load-test.k6.js:/load-test.k6.js \
  grafana/k6 run /load-test.k6.js
```

### Run k6 (Local)

```bash
# Install k6
brew install k6

# Run test
BASE_URL=http://localhost:3000 k6 run load-test.k6.js
```

---

## Expected Results

### Throughput

| Environment | Peak VUs | Requests/sec | Notes |
|-------------|----------|--------------|-------|
| Local (Docker Desktop) | 100 | 5,000-6,000 | Single API instance |
| Local (Native) | 100 | 8,000-10,000 | No Docker overhead |
| Cloud (c5.xlarge) | 1000 | 30,000+ | Production-like |

### Response Codes

| Code | Meaning | Expected % |
|------|---------|------------|
| 200 | Order accepted | ~2% (100 orders / 5000 requests) |
| 302 | Rate limited | ~5-20% (depends on rate limit) |
| 409 | Sold out | ~78-93% (after 100 sold) |

### Latency Percentiles

| Percentile | Expected (local) | Notes |
|------------|------------------|-------|
| p50 | < 5ms | Typical request |
| p90 | < 10ms | Most requests |
| p95 | < 20ms | Some contention |
| p99 | < 50ms | Outliers |

---

## Sample Output

```
          /\      |‾‾| /‾‾/   /‾‾/   
     /\  /  \     |  |/  /   /  /    
    /  \/    \    |     (   /   ‾‾\  
   /          \   |  |\  \ |  (‾)  | 
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: load-test.k6.js
     output: -

  scenarios: (100.00%) 1 scenario, 100 max VUs, 55s max duration
           * flash_sale: Up to 100 VUs for 25s

running (25.0s), 000/100 VUs, 157234 complete
flash_sale ✓ [======================================] 000/100 VUs  25s

     ✓ valid response

     checks.........................: 100.00% ✓ 157234  ✗ 0     
     data_received..................: 12 MB   480 kB/s
     data_sent......................: 45 MB   1.8 MB/s
     http_req_blocked...............: avg=3.2µs   p(90)=5µs    p(95)=6µs   
     http_req_connecting............: avg=1.1µs   p(90)=0s     p(95)=0s    
     http_req_duration..............: avg=2.89ms  p(90)=4.5ms  p(95)=6.2ms 
     http_req_receiving.............: avg=27.5µs  p(90)=45µs   p(95)=56µs  
     http_req_sending...............: avg=13.2µs  p(90)=24µs   p(95)=31µs  
     http_req_waiting...............: avg=2.85ms  p(90)=4.4ms  p(95)=6.1ms 
     http_reqs......................: 157234  6289/s
     iteration_duration.............: avg=3.01ms  p(90)=4.7ms  p(95)=6.4ms 
     iterations.....................: 157234  6289/s
     vus............................: 1       min=1     max=100 
     vus_max........................: 100     min=100   max=100 
```

### Key Metrics Analysis

| Metric | Value | Interpretation |
|--------|-------|----------------|
| `http_reqs` | 157,234 | Total requests in 25 seconds |
| `http_reqs/s` | 6,289/s | Peak throughput |
| `http_req_duration p95` | 6.2ms | 95% of requests under 6.2ms |
| `checks` | 100% ✓ | All responses valid |

---

## Verification

### After Load Test

```bash
# Check orders in database
docker exec -it postgres psql -U user -d fluxgate \
  -c "SELECT COUNT(*) FROM orders WHERE product_id = 'iphone-15';"
# Expected: 100

# Check stock
docker exec -it postgres psql -U user -d fluxgate \
  -c "SELECT stock FROM products WHERE id = 'iphone-15';"
# Expected: 0

# Check Redis stock
docker exec -it redis redis-cli GET product:iphone-15:stock
# Expected: 0
```

### Verify No Overselling

```sql
-- If this returns > 100, we oversold
SELECT COUNT(*) FROM orders WHERE product_id = 'iphone-15';
-- Must be exactly 100
```

---

## Bottleneck Analysis

### Identified Bottlenecks

| Component | Bottleneck At | Solution |
|-----------|---------------|----------|
| API | 30k RPS/instance | Add instances |
| Redis | 100k ops/sec | Unlikely bottleneck |
| Kafka | 1M msg/sec | Unlikely bottleneck |
| Worker | ~1k orders/sec | Add workers, batch |
| PostgreSQL | ~1k TPS | Connection pool, sharding |

### CPU/Memory Usage (Local Test)

| Component | CPU | Memory |
|-----------|-----|--------|
| Ingestion API | 40-60% | 100MB |
| Redis | 5-10% | 50MB |
| Kafka | 20-30% | 500MB |
| Worker | 10-20% | 80MB |
| PostgreSQL | 30-40% | 200MB |

---

## Stress Testing Scenarios

### Scenario 1: Sustained High Load

```javascript
export const options = {
    scenarios: {
        stress: {
            executor: 'constant-vus',
            vus: 100,
            duration: '5m',
        },
    },
};
```

Tests: Memory leaks, connection exhaustion

### Scenario 2: Spike Test

```javascript
export const options = {
    scenarios: {
        spike: {
            executor: 'ramping-vus',
            stages: [
                { duration: '10s', target: 10 },
                { duration: '1s', target: 500 },  // Sudden spike
                { duration: '10s', target: 500 },
                { duration: '1s', target: 10 },
            ],
        },
    },
};
```

Tests: Rate limiter, recovery from overload

### Scenario 3: Soak Test

```javascript
export const options = {
    scenarios: {
        soak: {
            executor: 'constant-vus',
            vus: 50,
            duration: '30m',
        },
    },
};
```

Tests: Long-term stability, memory leaks

---

## Custom Metrics

Add to k6 script for deeper analysis:

```javascript
import { Counter, Trend } from 'k6/metrics';

const orderAccepted = new Counter('orders_accepted');
const orderRejected = new Counter('orders_rejected');
const rateLimited = new Counter('rate_limited');
const orderLatency = new Trend('order_latency');

export default function () {
    const res = http.post(`${BASE_URL}/order`, payload, params);
    
    orderLatency.add(res.timings.duration);
    
    if (res.status === 200) orderAccepted.add(1);
    if (res.status === 409) orderRejected.add(1);
    if (res.status === 302) rateLimited.add(1);
}
```

---

## Related Documentation

- [CHAOS_TESTING.md](./CHAOS_TESTING.md) - Failure scenario testing
- [SCALING.md](./SCALING.md) - Scaling based on load test results
- [API_SPEC.md](./API_SPEC.md) - API endpoints being tested
