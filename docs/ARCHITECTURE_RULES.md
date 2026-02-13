# Architecture Rules

## Layer Definitions

| Layer | Responsibility | May Import | Must NOT Import |
|-------|---------------|------------|-----------------|
| `src/domain/` | Pure functions: validation, state transitions, computations. No async I/O. | `domain/`, `utils/exceptions` | `modules/`, `engines/`, `services/`, `pg`, EventBus, logger |
| `src/engines/` | Multi-step workflows: load, lock, validate, transition, persist. Returns event payloads. | `engines/`, `domain/`, `shared/`, repository types | `modules/` controllers, HTTP, direct socket emission |
| `src/modules/` | HTTP/socket handlers, permission checks, request-to-domain mapping. Thin facades. | All layers | Must not re-implement domain invariants |
| `src/services/` | Infrastructure: notifications, external APIs, caching, socket emission. | `shared/`, domain types only | Business rules, DB writes, domain logic |

## Import Rules (Enforced)

### Domain Layer (`src/domain/`)

- All functions must be **pure** (deterministic, no side effects)
- Zero async I/O: no `Pool`, `PoolClient`, `fetch`, `fs`, or network calls
- No `EventBus`, `logger`, or `io` (socket) imports
- May import only from other `domain/` files and `utils/exceptions`
- Must be fully unit-testable with zero mocks

### Engine Layer (`src/engines/`)

- Orchestrates: load state -> acquire lock -> call domain functions -> persist -> return event payloads
- May import `domain/` for business rules, `shared/` for transactions/locks, repository interfaces
- Must NOT call `eventBus.publish()` — returns event payloads for callers to emit
- Must NOT import `modules/` controllers or directly access HTTP request/response objects

### Module Layer (`src/modules/`)

- Thin facades: receive HTTP/socket request, call engine/service, emit events
- Handles permission checks, request parsing, response formatting
- Must NOT contain inline business logic (validation math, tiebreak formulas, ranking algorithms)
- Delegates all domain invariants to `domain/` or `engines/`

### Service Layer (`src/services/`)

- Infrastructure concerns only: notifications, caching, external API clients
- Must NOT contain business rules or write directly to the database
- May import domain types for data shaping

## PR Review Checklist

- [ ] No pure math/validation in module services (move to `domain/`)
- [ ] No `Pool` or `PoolClient` in domain files
- [ ] No `eventBus.publish()` inside transaction bodies (engines return payloads, callers emit)
- [ ] No duplicate tiebreak/budget/ranking logic across files
- [ ] Domain files have zero async I/O (no `await` on external resources)
- [ ] Engine methods return event payloads, not emit directly
- [ ] Module services are thin facades with no inline business logic
- [ ] New domain functions have unit tests with full branch coverage

## Single Source of Truth

These domain functions are canonical — no duplicates allowed elsewhere:

| Logic | Canonical Location | Grep Verification |
|-------|-------------------|-------------------|
| Auction budget math | `domain/auction/budget.ts` | No `totalBudget - spent` formulas elsewhere |
| Auction timer extension | `domain/auction/lot-timer.ts` | No `resetOnBid` logic elsewhere |
| Playoff tiebreaks | `domain/playoff/bracket.ts` | No `points > seed > rosterId` comparisons elsewhere |
| ADP player ranking | `domain/draft/player-ranking.ts` | No `adp ASC nulls last` sorting elsewhere |
| Pick validation | `domain/draft/pick-validation.ts` | No `NOT_YOUR_TURN` / `DRAFT_NOT_IN_PROGRESS` checks elsewhere |
| Nomination eligibility | `domain/auction/nomination.ts` | No nominator skip logic elsewhere |
