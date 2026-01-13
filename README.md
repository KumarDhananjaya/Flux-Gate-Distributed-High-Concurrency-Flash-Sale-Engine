# ⚡ Flux-Gate

> **A Distributed High-Concurrency Flash Sale Engine**

Handle **100,000+ requests per second** for high-demand inventory releases with **zero overselling**, **guaranteed fairness**, and **automatic back-pressure**.

![Flux-Gate Architecture](./assets/flux_gate_architecture.png)

---

## 📋 Table of Contents

- [Problem Statement](#-problem-statement)
- [Key Guarantees](#-key-guarantees)
- [Request Lifecycle](#-request-lifecycle)
- [Tech Stack](#-tech-stack)
- [Quick Start](#-quick-start)
- [Load Test Demo](#-load-test-demo)
- [Chaos Engineering Demo](#-chaos-engineering-demo)
- [Limitations & Trade-offs](#-limitations--trade-offs)
- [Documentation](#-documentation)

---

## 🎯 Problem Statement

**The Thundering Herd Problem**: During a flash sale (e.g., 100 iPhones at 50% off), millions of users click "Buy" simultaneously.

### Traditional Approach Fails
```
User → Web Server → Database (UPDATE stock = stock - 1)
```
- At 100k RPS, databases experience lock contention
- Row-level locks cause deadlocks and timeouts
- System crashes, users frustrated, revenue lost

### Flux-Gate Solution
```
User → Ingestion API → Redis (Lua) → Kafka → Worker → PostgreSQL
```
- **Decouple** request ingestion from order processing
- **Absorb** traffic spikes with in-memory stores
- **Process** orders asynchronously at sustainable pace

---

## 🛡️ Key Guarantees

| Guarantee | How It's Achieved |
|-----------|-------------------|
| **Zero Overselling** | Redis Lua script atomically checks AND decrements inventory in a single operation |
| **Fairness** | First-come-first-served via Redis atomic operations; no queue jumping |
| **Back-Pressure** | Token bucket rate limiter redirects excess traffic to waiting room (HTTP 302) |
| **Durability** | Orders persist in Kafka; survive worker crashes without data loss |
| **Consistency** | Optimistic locking in PostgreSQL as final safety net |

---

## 🔄 Request Lifecycle

```
┌─────────┐     ┌──────────────┐     ┌───────┐     ┌───────┐     ┌──────────┐     ┌────────────┐
│  User   │────▶│ Ingestion API│────▶│ Redis │────▶│ Kafka │────▶│  Worker  │────▶│ PostgreSQL │
└─────────┘     └──────────────┘     └───────┘     └───────┘     └──────────┘     └────────────┘
                      │                   │
                      │   Rate Limit?     │  Stock = 0?
                      ▼                   ▼
               ┌─────────────┐      ┌──────────┐
               │Waiting Room │      │ 409 Sold │
               │  (HTTP 302) │      │   Out    │
               └─────────────┘      └──────────┘
```

### Step-by-Step Flow

1. **Traffic Shaping**: Request hits rate limiter (token bucket in Redis)
   - Over limit → `HTTP 302` redirect to waiting room
   - Under limit → proceed

2. **Idempotency Check**: Validate `x-idempotency-key` header
   - Duplicate → return cached response
   - New → proceed

3. **Atomic Inventory**: Execute Redis Lua script
   - `if stock >= 1 then decrement; return SUCCESS`
   - Stock depleted → `HTTP 409 Conflict`

4. **Async Handoff**: Produce order message to Kafka topic
   - Response: `HTTP 200 Order Accepted` (< 10ms latency)

5. **Order Fulfillment**: Worker consumes from Kafka
   - PostgreSQL transaction with optimistic lock
   - Permanent order record created

---

## 🛠️ Tech Stack

| Component | Technology | Why This Choice |
|-----------|------------|-----------------|
| **Runtime** | Node.js (TypeScript) | Non-blocking I/O, excellent for high concurrency |
| **API Framework** | Fastify | 30k+ req/sec on single core; lower overhead than Express |
| **Message Broker** | Apache Kafka | Durable buffering, handles traffic spikes, horizontal scaling |
| **Cache/Locking** | Redis + Lua | Atomic operations, single-threaded execution eliminates races |
| **Database** | PostgreSQL | ACID compliance for final order records |
| **Load Testing** | k6 | Scriptable, Docker-friendly, realistic traffic simulation |
| **Infrastructure** | Docker Compose | Reproducible local environment |

> See [ARCHITECTURE.md](./ARCHITECTURE.md) for deep dive on technology choices.

---

## 🚀 Quick Start

### Prerequisites
- Node.js v18+
- Docker & Docker Compose

### 1. Start Infrastructure
```bash
docker-compose up -d
```

### 2. Install & Build
```bash
npm install
npm run build --workspaces
```

### 3. Run Services (3 terminals)

```bash
# Terminal 1: Ingestion API (port 3000)
npm start -w apps/ingestion-api

# Terminal 2: Inventory Worker
npm start -w apps/inventory-worker

# Terminal 3: Waiting Room (port 4000)
npm start -w apps/waiting-room
```

---

## 🧪 Load Test Demo

### Initialize Sale
```bash
curl -X POST http://localhost:3000/init \
  -H "Content-Type: application/json" \
  -d '{"productId": "iphone-15", "quantity": 100}'
```

### Run k6 Load Test
```bash
docker run --rm -i \
  -e BASE_URL=http://host.docker.internal:3000 \
  -v $(pwd)/load-test.k6.js:/load-test.k6.js \
  grafana/k6 run /load-test.k6.js
```

### Expected Results
| Metric | Value |
|--------|-------|
| Peak RPS | 6,000+ (local Docker) |
| Items Sold | Exactly 100 (zero oversell) |
| Response Codes | `200` (accepted), `302` (waiting room), `409` (sold out) |

> See [LOAD_TESTING.md](./LOAD_TESTING.md) for detailed test configuration.

---

## 💥 Chaos Engineering Demo

Demonstrate system resilience by killing components mid-sale:

1. **Start load test** (as above)
2. **Kill the worker**: `Ctrl+C` in worker terminal
3. **Observe**: Ingestion API keeps accepting orders → messages queue in Kafka
4. **Restart worker**: It catches up on backlog, processes all pending orders
5. **Result**: Zero data loss, zero overselling

> See [CHAOS_TESTING.md](./CHAOS_TESTING.md) for comprehensive failure scenarios.

---

## ⚠️ Limitations & Trade-offs

### Current Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| **Single Redis Instance** | SPOF for inventory state | Production: Redis Cluster or Sentinel |
| **Eventual Consistency** | Order "accepted" before DB commit | User sees confirmation; actual fulfillment async |
| **No Payment Integration** | Demo focuses on inventory, not checkout | Payment would be another async stage |
| **Kafka Ordering** | Single partition = ordered; multiple = per-partition only | Acceptable for inventory; order ID is idempotent |

### Design Trade-offs

| Trade-off | Choice Made | Alternative Rejected |
|-----------|-------------|---------------------|
| **Latency vs Durability** | Accept order fast, persist later | Synchronous DB write (too slow at scale) |
| **Consistency Model** | Eventual consistency | Strong consistency (bottleneck at DB) |
| **Complexity vs Performance** | Multi-service architecture | Monolith (can't scale components independently) |
| **Redis Lua vs Redlock** | Single Lua script (atomic) | Distributed lock (more round trips) |

### What Would Change at 1M RPS

- Redis Cluster with hash slots for inventory sharding
- Multiple Kafka partitions with partition-aware routing
- Connection pooling and read replicas for PostgreSQL
- CDN/edge caching for waiting room
- Geographic distribution for latency

> See [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md) for detailed reasoning.

---

## 📚 Documentation

| Document | Purpose |
|----------|---------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Deep system design, component interactions |
| [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md) | Engineering judgment, rejected alternatives |
| [API_SPEC.md](./API_SPEC.md) | Complete API reference |
| [DATA_MODEL.md](./DATA_MODEL.md) | Database schema, Redis keys, Kafka messages |
| [SCALING.md](./SCALING.md) | Horizontal scaling strategies |
| [FAILURE_MODES.md](./FAILURE_MODES.md) | Failure analysis and recovery |
| [CHAOS_TESTING.md](./CHAOS_TESTING.md) | Resilience testing procedures |
| [LOAD_TESTING.md](./LOAD_TESTING.md) | Performance benchmarks |
| [SECURITY.md](./SECURITY.md) | Security considerations |
| [ROADMAP.md](./ROADMAP.md) | Future enhancements |

---

## 👤 Author

**Kumar Dhananjaya**

## 📄 License

MIT
