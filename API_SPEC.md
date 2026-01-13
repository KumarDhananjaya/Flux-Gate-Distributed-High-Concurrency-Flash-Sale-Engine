# 📡 API Specification

> Complete API reference for Flux-Gate ingestion service

---

## Base URL

```
http://localhost:3000
```

---

## Authentication

Currently, the API does not require authentication. In production, you would add:
- API keys for service-to-service calls
- JWT tokens for user authentication
- Rate limit tiers based on authentication level

---

## Endpoints

### POST /init

Initialize or reset inventory for a product.

#### Request

```http
POST /init HTTP/1.1
Host: localhost:3000
Content-Type: application/json

{
  "productId": "iphone-15",
  "quantity": 100
}
```

#### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `productId` | string | Yes | Unique identifier for the product |
| `quantity` | integer | Yes | Initial stock quantity |

#### Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "ok",
  "msg": "Stock initialized for iphone-15 to 100"
}
```

#### Status Codes

| Code | Description |
|------|-------------|
| 200 | Stock initialized successfully |
| 500 | Internal server error (Redis unavailable) |

---

### POST /order

Attempt to purchase a product. This is the main endpoint for flash sale traffic.

#### Request

```http
POST /order HTTP/1.1
Host: localhost:3000
Content-Type: application/json
x-idempotency-key: 550e8400-e29b-41d4-a716-446655440000

{
  "productId": "iphone-15",
  "userId": "user-12345"
}
```

#### Headers

| Header | Type | Required | Description |
|--------|------|----------|-------------|
| `Content-Type` | string | Yes | Must be `application/json` |
| `x-idempotency-key` | string (UUID) | Yes | Unique key to prevent duplicate orders |

#### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `productId` | string | Yes | Product to purchase |
| `userId` | string | Yes | Identifier of the purchasing user |

#### Responses

##### Success (Order Accepted)

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "success",
  "msg": "Order accepted"
}
```

The order has been:
1. Reserved in Redis (stock decremented)
2. Queued in Kafka for processing
3. Will be persisted to PostgreSQL asynchronously

##### Redirect (Rate Limited)

```http
HTTP/1.1 302 Found
Location: http://localhost:4000
```

Traffic has exceeded the rate limit threshold. The user should:
1. Follow the redirect to the waiting room
2. Wait for the page to auto-refresh
3. Retry the request

##### Conflict (Sold Out)

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "status": "sold_out",
  "msg": "Inventory empty"
}
```

The product is no longer available. No further attempts will succeed.

##### Bad Request (Missing Idempotency Key)

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "Missing Idempotency Key"
}
```

All order requests must include the `x-idempotency-key` header.

##### Duplicate Request (Idempotent)

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "ignored",
  "msg": "Duplicate request"
}
```

This idempotency key was already processed. The original order stands.

##### Internal Error

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json

{
  "status": "error",
  "msg": "Order processing failed"
}
```

An error occurred (e.g., Kafka unavailable). The stock may have been decremented. Manual reconciliation may be needed.

#### Status Codes Summary

| Code | Meaning | Action |
|------|---------|--------|
| 200 | Order accepted | Show confirmation to user |
| 302 | Rate limited | Redirect to waiting room |
| 400 | Bad request | Fix client request |
| 409 | Sold out | Show "sold out" message |
| 500 | Server error | Retry with same idempotency key |

---

## Rate Limiting Behavior

### How It Works

The API implements a **token bucket** rate limiter:

- **Window**: 1 second
- **Threshold**: 50 requests/second (demo) or 10,000/second (production)
- **Action**: HTTP 302 redirect to waiting room

### Detection

You're being rate limited if you receive:
```http
HTTP/1.1 302 Found
Location: http://localhost:4000
```

### Recovery

1. Follow redirect to waiting room
2. Waiting room HTML includes auto-refresh logic
3. User is automatically retried when capacity available

---

## Idempotency

### Purpose

Prevent duplicate orders from:
- Network retries
- Double-clicks
- Client-side bugs

### Implementation

1. Client generates a UUID v4 for each unique order intention
2. Include in `x-idempotency-key` header
3. Server checks Redis for key existence
4. Keys expire after 60 seconds

### Best Practices

```javascript
// Client-side example
const orderId = crypto.randomUUID();

async function placeOrder(productId, userId) {
  const response = await fetch('/order', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-idempotency-key': orderId  // Same key for retries
    },
    body: JSON.stringify({ productId, userId })
  });
  
  if (response.status === 302) {
    // Rate limited, redirect to waiting room
    window.location = response.headers.get('Location');
  }
  
  return response.json();
}
```

---

## Error Handling

### Retry Strategy

| Status Code | Retry? | Strategy |
|-------------|--------|----------|
| 200 | No | Success |
| 302 | Yes | Follow redirect, auto-retry |
| 400 | No | Fix request |
| 409 | No | Sold out, stop retrying |
| 500 | Yes | Exponential backoff, same idempotency key |

### Recommended Backoff

```javascript
const delays = [100, 200, 500, 1000, 2000]; // ms

for (let i = 0; i < delays.length; i++) {
  const response = await placeOrder(productId, userId);
  if (response.status !== 500) break;
  await sleep(delays[i]);
}
```

---

## Example: Complete Flow

### 1. Initialize Sale

```bash
curl -X POST http://localhost:3000/init \
  -H "Content-Type: application/json" \
  -d '{"productId": "ps5-disc", "quantity": 50}'
```

### 2. Place Order

```bash
curl -X POST http://localhost:3000/order \
  -H "Content-Type: application/json" \
  -H "x-idempotency-key: $(uuidgen)" \
  -d '{"productId": "ps5-disc", "userId": "user-42"}'
```

### 3. Handle Responses

```bash
# Success
{"status":"success","msg":"Order accepted"}

# Sold out
{"status":"sold_out","msg":"Inventory empty"}

# Duplicate
{"status":"ignored","msg":"Duplicate request"}
```

---

## Future Enhancements

| Feature | Description |
|---------|-------------|
| `GET /status/:orderId` | Check order fulfillment status |
| `GET /inventory/:productId` | Check current stock (read-only) |
| `POST /cancel/:orderId` | Cancel pending order |
| WebSocket `/events` | Real-time inventory updates |
