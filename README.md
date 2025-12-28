# ⚡️ Flux-Gate: Distributed High-Concurrency Flash Sale Engine

> **The "Tier 1" System Design Project**  
> A backend system designed to handle **100,000+ requests per second** for high-demand inventory releases (e.g., "100 iPhones for sale") ensuring **zero overselling**, **fairness**, and **resilience**.

---

## 🏗 System Architecture

Flux-Gate moves away from the traditional Monolith (Client → Server → DB) to an **Event-Driven Microservices Architecture** optimized for extreme concurrency.

### The Flow
1.  **Ingestion Service (Node.js/Fastify)**: The high-performance entry point. It doesn't touch the database. It talks only to Redis.
2.  **Redis (The Gatekeeper)**: Uses **Lua Scripts** to atomically check and decrement inventory. This eliminates race conditions.
3.  **Virtual Waiting Room**: If traffic exceeds the configured threshold (e.g., 10k/sec), users are redirected (HTTP 302) to a static HTML waiting room to protect downstream services.
4.  **Apache Kafka (The Buffer)**: Successful orders are pushed to a Kafka topic. This decouples ingestion from processing, allowing the API to respond in milliseconds.
5.  **Inventory Worker**: Consumes messages from Kafka at its own pace and updates the **PostgreSQL** database using **Optimistic Concurrency Control**.

---

## 🛠 Tech Stack (2025 Standards)

| Component | Technology | Reasoning |
| :--- | :--- | :--- |
| **Language** | TypeScript (Node.js) | High I/O performance, excellent ecosystem. |
| **API Framework** | Fastify | Lower overhead than Express, critical for high RPS. |
| **Message Broker** | Apache Kafka | Durable buffering for order spikes. |
| **Database** | PostgreSQL | ACID compliance for final data recording. |
| **Cache/Locking** | Redis + Lua | Atomic operations for real-time inventory. |
| **Infrastructure** | Docker & Compose | Containerized local development. |
| **Testing** | k6 | Load testing to simulate 50k+ Virtual Users. |

---

## 🚀 Key "Advanced" Features

### 1. Atomic Inventory Management (The "Anti-Oversell")
**Problem:** Two users try to buy the last item at the exact same millisecond. Traditional DB transactions are too slow.  
**Solution:** We use **Redis Lua Scripts**.
> "Check if Count > 0. If yes, Decrement Count. All in one atomic operation."
*   **Result**: 0% overselling, guaranteed.

### 2. The Virtual Waiting Room (Traffic Shaping)
**Problem:** 100k users hit the login API simultaneously, crashing the Auth Service (Thundering Herd).  
**Solution:** A **Token Bucket** rate limiter in Redis.
*   If traffic > Limit: Redirect to `http://waiting-room-url/`.
*   Users wait in a lightweight static page, reducing load on the core API to zero.

### 3. Asynchronous Processing
**Problem:** Writing to a relational database takes ~10-50ms. At 100k RPS, the DB will melt.  
**Solution:** The API pushes to **Kafka** (~1ms latency) and returns "Order Accepted". Workers process the backlog asynchronously.

### 4. Idempotency & Concurrency Control
*   **Idempotency Keys**: Prevents double-charging if a user clicks "Buy" twice.
*   **Optimistic Locking**: The database worker checks `WHERE stock > 0` before final commit.

---

## 💻 Getting Started

### Prerequisites
*   Node.js v18+
*   Docker & Docker Compose

### 1. Start Infrastructure
Spin up Kafka, Zookeeper, Redis, and Postgres.
```bash
docker-compose up -d
```

### 2. Install Dependencies & Build
We use npm workspaces for the monorepo structure.
```bash
npm install
npm run build --workspaces
```

### 3. Run the Microservices
Open 3 separate terminals:

**Terminal 1: Ingestion API**
```bash
npm start -w apps/ingestion-api
```
*Runs on port 3000*

**Terminal 2: Inventory Worker**
```bash
npm start -w apps/inventory-worker
```
*Connects to Kafka & Postgres*

**Terminal 3: Virtual Waiting Room**
```bash
npm start -w apps/waiting-room
```
*Runs on port 4000*

---

## 🧪 Simulation & Load Testing

We use **k6** to simulate a massive flash sale event.

**1. Initialize the Sale**
```bash
curl -X POST http://localhost:3000/init \
  -H "Content-Type: application/json" \
  -d '{"productId": "iphone-15", "quantity": 100}'
```

**2. Unleash the Traffic (Load Test)**
Run the k6 script via Docker (no local k6 installation needed).
```bash
docker run --interactive --rm \
  -e BASE_URL=http://host.docker.internal:3000 \
  -v $(pwd)/load-test.k6.js:/load-test.k6.js \
  grafana/k6 run /load-test.k6.js
```

### Expected Results
*   **Throughput**: You should see thousands of requests per second.
*   **Inventory**: Exactly 100 items will be sold.
*   **Responses**:
    *   200 OK: "Order accepted"
    *   302 Found: Redirect to Waiting Room (when rate limit hit)
    *   409 Conflict: "Inventory empty" (when sold out)

---

## 💥 Chaos Engineering Demo

To demonstrate system resilience to recruiters:
1.  Start the Load Test.
2.  **Kill the Worker**: `Ctrl+C` in the Inventory Worker terminal.
3.  **Observation**: The Ingestion API **keeps accepting orders** successfully. Messages pile up in Kafka (zero data loss).
4.  **Recovery**: Restart the worker. It will furiously process the backlog and update the database.

---
**Author**: Kumar Dhananjaya  
**License**: MIT
