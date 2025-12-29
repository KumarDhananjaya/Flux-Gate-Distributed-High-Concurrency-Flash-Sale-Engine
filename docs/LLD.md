# Low-Level Design (LLD) - Flux-Gate

## 1. Inventory Management (Redis + Lua)
To prevent overselling in a distributed environment, we must ensure that checking the stock and decrementing it happens in a single, non-interruptible operation.

### `decrementStock` Lua Script
```lua
local stockKey = KEYS[1]
local qty = tonumber(ARGV[1])
local current = tonumber(redis.call('get', stockKey) or "0")

if current >= qty then
  redis.call('decrby', stockKey, qty)
  return 1 -- Success
else
  return 0 -- Failed (Out of Stock)
end
```
**Why Lua?**
Redis executes Lua scripts atomically. No other command can run while the script is executing, effectively providing a server-side lock without the overhead of client-side locks or distributed mutexes (Redlock).

---

## 2. Messaging Strategy (Kafka)
Kafka acts as a durable buffer.

### Topic: `orders`
- **Partitions**: Recommended 3 or more for horizontal scalability.
- **Message Format**:
  ```json
  {
    "orderId": "uuid-v4",
    "productId": "iphone-15",
    "userId": "user-123",
    "timestamp": 1700000000000
  }
  ```

### Consumer Group: `inventory-group`
- Workers belong to this group to ensure that each message is processed exactly once by one of the workers.
- **Commit Strategy**: Manual commit after successful DB persistence to ensure no message is lost.

---

## 3. Database Schema (PostgreSQL)
The relational database stores the final consistent state.

### Table: `products`
| Column | Type | Constraints |
| :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY |
| `stock` | INTEGER | NOT NULL, CHECK (stock >= 0) |

### Table: `orders`
| Column | Type | Constraints |
| :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY |
| `product_id` | TEXT | NOT NULL, FK -> products.id |
| `user_id` | TEXT | NOT NULL |
| `created_at` | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP |

---

## 4. Concurrency Control (Worker Logic)
Even though Redis is the primary gatekeeper, the database logic uses **Optimistic Concurrency Control** for added safety.

### SQL for Inventory Update
```sql
UPDATE products 
SET stock = stock - 1 
WHERE id = $1 AND stock > 0;
```
If `rowCount` is 0, it indicates an inconsistency between Redis and Postgres, which triggers an alert for manual reconciliation.

---

## 5. Traffic Shaping (Rate Limiting)
A sliding window or token bucket algorithm is implemented in Redis to redirect excess traffic.

### Token Bucket Logic
1. Each request checks a Redis key for the current rate.
2. If `currentRate > 10000`, redirect (HTTP 302) to the Static Waiting Room.
3. This protects the Ingestion API and Kafka from being overwhelmed by a "Thundering Herd".

---

## 6. API Error Handling
- **400 Bad Request**: Missing mandatory fields or invalid idempotency key.
- **409 Conflict**: Redis stock is 0.
- **302 Found**: Current traffic exceeds threshold (Waitroom Redirection).
- **500 Internal Server Error**: Kafka or Redis connection failure.
