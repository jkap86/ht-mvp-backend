# Architecture Decisions

## 1. Dependency Injection Pattern

**Decision:** Manual container-based DI without decorators

**Rationale:**
- Simple, explicit, no magic
- Easy to test with mocks via `container.override()`
- No runtime reflection or metadata requirements
- Clear dependency graph in `bootstrap.ts`

**Implementation:**
- `container.ts` - Container class with `register/resolve/override`
- `bootstrap.ts` - All service registrations in one place
- Keys defined in `KEYS` constant for type safety

## 2. Draft Engine Strategy Pattern

**Decision:** Strategy pattern for draft types (snake, linear, auction)

**Rationale:**
- Each draft type has different pick order logic
- Clean separation of concerns
- Easy to add new draft types
- Single `tick()` method handles autopick logic

**Implementation:**
- `IDraftEngine` interface defines contract
- `BaseDraftEngine` abstract class with shared logic
- `SnakeDraftEngine`, `LinearDraftEngine` implementations
- `DraftEngineFactory` creates appropriate engine

## 3. Token Refresh Flow

**Decision:** Short-lived access tokens (15min) + long-lived refresh tokens (30d)

**Rationale:**
- Limits exposure if access token is compromised
- Refresh tokens allow seamless UX
- Frontend handles 401 → refresh → retry automatically

**Implementation:**
- `POST /api/auth/refresh` endpoint
- Frontend intercepts 401s and refreshes
- Socket reconnects after token refresh

## 4. Background Job Gating

**Decision:** `RUN_JOBS=true` environment flag controls job execution

**Rationale:**
- Prevents duplicate job execution in multi-instance deployments
- Single instance runs jobs, others only serve API
- Easy to toggle in development

**Implementation:**
- `env.config.ts` parses `RUN_JOBS` flag
- `server.ts` conditionally starts job scheduler
- Jobs: autopick timer, player sync

## 5. Error Response Contract

**Decision:** Unified error format across all endpoints

**Format:**
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message"
  }
}
```

**Exception Classes:**
- `ValidationException` (400, VALIDATION_ERROR)
- `InvalidCredentialsException` (401, INVALID_CREDENTIALS)
- `ForbiddenException` (403, FORBIDDEN)
- `NotFoundException` (404, NOT_FOUND)
- `ConflictException` (409, CONFLICT)

**Implementation:**
- `utils/exceptions.ts` - Exception hierarchy
- `middleware/error.middleware.ts` - Central error handler
- All controllers use `next(error)` pattern

## 6. Socket.IO Room Structure

**Decision:** Hierarchical room naming for targeted broadcasts

**Rooms:**
- `league:{id}` - All league members (chat, general updates)
- `draft:{id}` - Active draft participants (picks, timer)
- `user:{id}` - Individual user (private notifications)

**Rationale:**
- Efficient broadcasting to relevant clients only
- No need to filter on client side
- Clear ownership of events

## 7. Database Schema Conventions

**Naming:**
- Tables: snake_case plural (users, leagues, draft_picks)
- Columns: snake_case (created_at, league_id)
- TypeScript: camelCase (createdAt, leagueId)

**Standard Columns:**
- `id SERIAL PRIMARY KEY`
- `created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`
- `updated_at TIMESTAMPTZ` with trigger

**JSONB Usage:**
- `settings` - User/league preferences
- `draft_state` - Complex runtime state
