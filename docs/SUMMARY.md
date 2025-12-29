# Flux-Gate Project Documentation

Welcome to the comprehensive documentation for **Flux-Gate**, a high-concurrency flash sale engine. This documentation is designed to help you understand the architecture, implementation details, and prepare for interviews.

## 📚 Table of Contents

1.  **[High-Level Design (HLD)](./HLD.md)** - Overview of the system architecture, components, and technology stack.
2.  **[Low-Level Design (LLD)](./LLD.md)** - Deep dive into Redis Lua scripts, Kafka strategy, and database schema.
3.  **[Interview Preparation Guide](./INTERVIEW_PREP.md)** - 20+ Q&A covering Distributed Systems, Concurrency, and Flash Sale Engines.
4.  **[System Design Deep Dive](./SYSTEM_DESIGN_DEEP_DIVE.md)** - In-depth analysis of scaling, resilience, and specific design patterns (Waiting Room, Idempotency).

---

## 🚀 Key Learning Objectives
- Understanding **Atomic Operations** in Redis.
- Implementing the **Transactional Outbox** or **Eventual Consistency** patterns with Kafka.
- Managing **Traffic Surges** with Virtual Waiting Rooms.
- Ensuring **Idempotency** in distributed environments.
