# 🔒 Security Considerations

> Security awareness and threat mitigation for Flux-Gate

---

## Security Overview

Flash sale systems are prime targets for abuse. This document outlines potential threats and mitigations implemented in Flux-Gate.

---

## Threat Model

| Threat | Risk Level | Impact | Status |
|--------|------------|--------|--------|
| Inventory manipulation | Critical | Overselling, revenue loss | ✅ Mitigated |
| Replay attacks | High | Duplicate orders | ✅ Mitigated |
| Rate limit bypass | High | System overload | ✅ Mitigated |
| Bot/script abuse | Medium | Unfair advantage | ⚠️ Partial |
| Data exposure | Medium | Privacy breach | ⚠️ Partial |

---

## 1. Idempotency Abuse Prevention

### Threat
Malicious client sends same order with different idempotency keys to bypass duplicate detection.

### Mitigation

**Current Implementation**:
- Idempotency key is client-generated
- Keys expire after 60 seconds
- No enforcement of key uniqueness per user

**Recommendations for Production**:
```typescript
// 1. Require authenticated user
const userId = request.auth.userId;

// 2. Composite key: userId + productId + timestamp window
const key = `${userId}:${productId}:${Math.floor(Date.now()/60000)}`;

// 3. Server-generated order ID (not client)
const orderId = crypto.randomUUID();
```

### Why This Matters
Without proper idempotency:
- Same user could buy multiple items
- Script could drain inventory
- Legitimate customers miss out

---

## 2. Replay Attack Mitigation

### Threat
Attacker captures valid request and replays it.

### Current Protection

```http
POST /order
x-idempotency-key: 550e8400-e29b-41d4-a716-446655440000
```

If the same key is replayed within 60 seconds:
```json
{
  "status": "ignored",
  "msg": "Duplicate request"
}
```

### Enhanced Protection

```typescript
// Add timestamp validation
const requestTime = parseInt(request.headers['x-request-time']);
const now = Date.now();

if (Math.abs(now - requestTime) > 30000) {
    return reply.code(400).send({ error: 'Request expired' });
}

// Add request signing
const signature = request.headers['x-signature'];
const payload = `${method}:${path}:${body}:${requestTime}`;
const expected = crypto.hmac('sha256', API_SECRET, payload);

if (signature !== expected) {
    return reply.code(401).send({ error: 'Invalid signature' });
}
```

---

## 3. Rate Limit Bypass Risks

### Threat
Attacker distributes requests across IPs to bypass rate limiting.

### Current Protection

Rate limiting is global (all requests share the limit):
```typescript
const rateKey = `rate:${currentSecond}`;  // Global
```

### Vulnerabilities

| Attack | Current Status |
|--------|----------------|
| Single IP flood | ✅ Blocked at 50 RPS |
| Distributed attack | ⚠️ Shares global limit |
| IP rotation | ⚠️ No per-IP tracking |

### Enhanced Protection

```typescript
// Per-IP rate limiting
const clientIP = request.ip;
const ipKey = `rate:ip:${clientIP}:${currentSecond}`;
const ipRate = await redis.incr(ipKey);

if (ipRate > 10) {  // 10/sec per IP
    return reply.code(429).send({ error: 'Too many requests' });
}

// Fingerprinting (browser-based)
const fingerprint = request.headers['x-device-fingerprint'];
const fpKey = `rate:fp:${fingerprint}:${currentSecond}`;
```

---

## 4. Redis Key Exposure

### Threat
Unauthorized access to Redis could manipulate inventory.

### Current Risk

```
# An attacker with Redis access could:
SET product:iphone-15:stock 99999999
# Or:
DEL rate:1705234800
```

### Mitigations

| Mitigation | Implementation |
|------------|----------------|
| Network isolation | Redis not exposed to internet |
| Authentication | `requirepass` in redis.conf |
| ACLs | Limit commands per user |
| Encryption | TLS for Redis connections |

```bash
# Redis configuration
requirepass your-strong-password
rename-command FLUSHALL ""
rename-command FLUSHDB ""
rename-command DEBUG ""
```

### Production Redis ACL

```
# redis-users.acl
user api on +incr +get +set +expire +eval ~product:* ~rate:* ~idempotency:* >api-password
user worker on +get ~product:* >worker-password
default off
```

---

## 5. Kafka Topic ACLs

### Current Risk
In development, Kafka has no ACLs. Any client can produce/consume.

### Production ACLs

```bash
# Create ACLs
kafka-acls.sh --add \
  --allow-principal User:ingestion-api \
  --producer \
  --topic orders

kafka-acls.sh --add \
  --allow-principal User:inventory-worker \
  --consumer \
  --topic orders \
  --group inventory-group
```

| Principal | Topic | Permission |
|-----------|-------|------------|
| ingestion-api | orders | WRITE |
| inventory-worker | orders | READ |
| admin | * | ALL |

---

## 6. Input Validation

### Current Implementation

```typescript
// Minimal validation
const { productId, userId } = request.body as any;

if (!idempotencyKey) {
    return reply.code(400).send({ error: 'Missing Idempotency Key' });
}
```

### Recommended Validation

```typescript
import Ajv from 'ajv';

const schema = {
    type: 'object',
    properties: {
        productId: { 
            type: 'string', 
            pattern: '^[a-z0-9-]+$',
            maxLength: 50 
        },
        userId: { 
            type: 'string', 
            pattern: '^[a-z0-9-]+$',
            maxLength: 50 
        }
    },
    required: ['productId', 'userId'],
    additionalProperties: false
};

const validate = ajv.compile(schema);

if (!validate(request.body)) {
    return reply.code(400).send({ 
        error: 'Invalid request',
        details: validate.errors 
    });
}
```

### SQL Injection Prevention

Using parameterized queries (already implemented):
```typescript
// Safe
await client.query(
    'INSERT INTO orders (id, product_id, user_id) VALUES ($1, $2, $3)',
    [orderId, productId, userId]
);

// Unsafe (never do this)
await client.query(`INSERT INTO orders VALUES ('${orderId}', ...)`);
```

---

## 7. Bot Detection (Future)

### Current State
No bot detection. Scripts can purchase like real users.

### Recommendations

| Technique | Effectiveness | Complexity |
|-----------|---------------|------------|
| CAPTCHA | High | Medium |
| Behavioral analysis | Medium | High |
| Device fingerprinting | Medium | Medium |
| Request timing analysis | Low | Low |

```typescript
// Basic bot detection
const requestInterval = now - lastRequestTime;
if (requestInterval < 100) {  // < 100ms = likely bot
    return reply.code(429).send({ error: 'Slow down' });
}
```

---

## 8. Data Privacy

### Sensitive Data Handled

| Data | Storage | Encryption |
|------|---------|------------|
| User ID | PostgreSQL, Kafka | No (pseudonymous) |
| IP Address | Not stored | N/A |
| Order details | PostgreSQL | At-rest (if enabled) |

### GDPR Considerations

- User IDs should be pseudonymous
- Implement data deletion on request
- Log retention policies

---

## Security Checklist

### Development
- [x] Parameterized SQL queries
- [x] Idempotency key requirement
- [x] Rate limiting implemented
- [ ] Input validation (partial)
- [ ] Authentication
- [ ] HTTPS/TLS

### Production
- [ ] Redis authentication + ACLs
- [ ] Kafka ACLs
- [ ] Database encryption at rest
- [ ] TLS for all connections
- [ ] WAF/DDoS protection
- [ ] Security audit logging
- [ ] Penetration testing

---

## Incident Response

### If Inventory Manipulation Detected

1. **Immediate**: Stop all order processing
```bash
# Set stock to 0
redis-cli SET product:{id}:stock 0
```

2. **Investigate**: Query suspicious orders
```sql
SELECT * FROM orders 
WHERE created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at;
```

3. **Remediate**: Reverse fraudulent orders
4. **Report**: Document incident

### If Rate Limit Bypassed

1. **Immediate**: Enable stricter limits
2. **Block**: Offending IPs/fingerprints
3. **Analyze**: Attack pattern
4. **Harden**: Implement additional controls

---

## Related Documentation

- [API_SPEC.md](./API_SPEC.md) - API security requirements
- [FAILURE_MODES.md](./FAILURE_MODES.md) - Security failure scenarios
- [DATA_MODEL.md](./DATA_MODEL.md) - Data storage security
