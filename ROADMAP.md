# 🚀 Roadmap

> Future enhancements and product evolution for Flux-Gate

---

## Vision

Evolve Flux-Gate from a demo into a **production-ready, globally-distributed flash sale platform** that handles millions of concurrent users with real payment processing and fraud prevention.

---

## Current State (v1.0)

### ✅ Implemented

| Feature | Status |
|---------|--------|
| Atomic inventory (Redis Lua) | ✅ Complete |
| Async order processing (Kafka) | ✅ Complete |
| Rate limiting + Waiting room | ✅ Complete |
| Idempotency keys | ✅ Complete |
| Optimistic locking (DB) | ✅ Complete |
| Load testing (k6) | ✅ Complete |
| Chaos testing | ✅ Complete |

### ⚠️ Demo Limitations

| Limitation | Production Requirement |
|------------|------------------------|
| Single Redis instance | Redis Cluster/Sentinel |
| No authentication | JWT/OAuth2 |
| No payment integration | Stripe/PayPal |
| No observability | Prometheus/Grafana |
| Single region | Multi-region |

---

## Short-Term Roadmap (v1.1 - v1.5)

### v1.1: Observability

**Goal**: Full visibility into system health

| Feature | Priority | Effort |
|---------|----------|--------|
| Prometheus metrics | P0 | 2 days |
| Grafana dashboards | P0 | 1 day |
| Structured logging (pino) | P1 | 1 day |
| Distributed tracing (Jaeger) | P1 | 2 days |

**Metrics to capture**:
- Order throughput (orders/sec)
- Latency percentiles (p50, p95, p99)
- Redis operations/sec
- Kafka consumer lag
- Error rates by type

### v1.2: Authentication & Authorization

**Goal**: Secure, user-authenticated ordering

| Feature | Priority | Effort |
|---------|----------|--------|
| JWT validation | P0 | 2 days |
| User service integration | P0 | 3 days |
| Per-user rate limiting | P1 | 1 day |
| Admin-only /init endpoint | P1 | 0.5 days |

```typescript
// Protected endpoint
fastify.register(require('@fastify/jwt'));

fastify.addHook('onRequest', async (request, reply) => {
    await request.jwtVerify();
});
```

### v1.3: Payment Integration

**Goal**: Real payment processing with flash sale semantics

| Feature | Priority | Effort |
|---------|----------|--------|
| Stripe integration | P0 | 3 days |
| Payment intent flow | P0 | 2 days |
| Reservation expiry | P0 | 2 days |
| Refund handling | P1 | 2 days |

**Flow**:
```
1. Reserve inventory (Redis)
2. Create payment intent (Stripe)
3. User completes payment
4. Confirm order (Kafka → DB)
5. On timeout: Release reservation
```

### v1.4: Fraud Detection

**Goal**: Prevent bot abuse and fraud

| Feature | Priority | Effort |
|---------|----------|--------|
| Device fingerprinting | P0 | 2 days |
| Velocity checks | P0 | 2 days |
| CAPTCHA integration | P1 | 1 day |
| ML-based scoring | P2 | 5 days |

**Rules engine**:
```typescript
const fraudScore = await checkFraud({
    userId,
    deviceId,
    ip: request.ip,
    orderCount24h: await getOrderCount(userId, 24),
});

if (fraudScore > 0.8) {
    return reply.code(403).send({ error: 'Blocked' });
}
```

### v1.5: Multi-Product Support

**Goal**: Handle multiple products in single sale

| Feature | Priority | Effort |
|---------|----------|--------|
| Product catalog service | P0 | 3 days |
| Cart/bundle purchases | P1 | 3 days |
| Product-specific limits | P1 | 2 days |
| Category-based traffic shaping | P2 | 2 days |

---

## Medium-Term Roadmap (v2.0)

### v2.0: Global Distribution

**Goal**: Sub-50ms latency worldwide

| Feature | Priority | Effort |
|---------|----------|--------|
| Multi-region Redis | P0 | 5 days |
| Regional Kafka clusters | P0 | 5 days |
| Geo-routing | P0 | 3 days |
| Cross-region inventory sync | P0 | 5 days |

**Architecture**:
```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  US-East    │  │  EU-West    │  │  Asia-Pac   │
│  - Redis    │  │  - Redis    │  │  - Redis    │
│  - Kafka    │  │  - Kafka    │  │  - Kafka    │
│  - API      │  │  - API      │  │  - API      │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────────────┼────────────────┘
                        │
                ┌───────▼───────┐
                │  Global DB    │
                │  (CockroachDB)│
                └───────────────┘
```

**Inventory Strategy**:
```
Total: 1000 units
US-East: 400 allocated
EU-West: 350 allocated  
Asia-Pac: 250 allocated
Overflow: Global queue
```

---

## Long-Term Vision (v3.0+)

### v3.0: Platform

**Goal**: Self-service flash sale platform for merchants

| Feature | Description |
|---------|-------------|
| Merchant dashboard | Configure sales, inventory |
| Webhook notifications | Order events to merchants |
| White-label waiting room | Custom branding |
| Analytics | Real-time sale metrics |

### Future Considerations

| Feature | Complexity | Value |
|---------|------------|-------|
| NFT/Digital goods | Medium | High |
| Auction mode | High | Medium |
| Pre-registration | Low | High |
| Lottery mode | Low | Medium |

---

## Technical Debt

### To Address

| Item | Priority | Effort |
|------|----------|--------|
| Type-safe Kafka messages (Avro) | P1 | 2 days |
| Database migrations (Flyway) | P1 | 1 day |
| Config management | P1 | 1 day |
| Health check endpoints | P0 | 0.5 days |
| Graceful shutdown | P0 | 1 day |

### Code Quality

| Item | Status |
|------|--------|
| Unit tests | ❌ Missing |
| Integration tests | ❌ Missing |
| E2E tests | ✅ k6 load tests |
| CI/CD pipeline | ❌ Missing |

---

## Milestones

| Milestone | Target | Key Deliverables |
|-----------|--------|------------------|
| v1.1 | Q1 2025 | Observability stack |
| v1.5 | Q2 2025 | Payment + fraud |
| v2.0 | Q4 2025 | Global distribution |
| v3.0 | 2026 | Platform launch |

---

## Contributing

Interested in contributing to Flux-Gate? Here are high-impact areas:

1. **Observability** - Add Prometheus metrics
2. **Testing** - Add unit and integration tests
3. **Documentation** - Improve operational runbooks
4. **Security** - Add authentication layer

See [ARCHITECTURE.md](./ARCHITECTURE.md) to understand the codebase.

---

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - Current system design
- [SCALING.md](./SCALING.md) - Scaling strategies
- [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md) - Past decisions informing future
