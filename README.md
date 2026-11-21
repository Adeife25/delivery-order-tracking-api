# Delivery and Order Tracking API

https://delivery-order-tracking-api.onrender.com
==>  primary url
live 🎉

https://delivery-order-tracking-api.onrender.com/api/v1/health/ready

NestJS and TypeScript modular-monolith API for the delivery and order tracking
system. The application is organized into Auth, Users, Orders, Deliveries,
Tracking, Payments, Notifications, Admin, and Health modules. Authentication,
user profiles, order management, Paystack payments, rider assignment and
reassignment, the rider delivery lifecycle, live Socket.IO tracking,
database-backed notifications, administrative account management, rate
limiting, structured request logging, and readiness checks are implemented.
Redis backs shared rate limiting, cross-instance Socket.IO delivery, and the
BullMQ notification queue so the API can run as multiple replicas.

## Requirements

- Node.js 22+
- npm
- Docker with Docker Compose (MongoDB 7 replica set and Redis 7)

## Local setup

```bash
npm ci
Copy-Item .env.example .env
docker compose up -d mongo mongo-init redis
npm run db:sync:indexes
npm run start:dev
```

The API listens on `http://localhost:3000`. The health endpoint is
`GET /api/v1/health`; Swagger UI is available at `/api/docs`. If host port
`27017` is already in use, change the host-side mapping in `docker-compose.yml`
and update `DATABASE_URL` to match. The Compose MongoDB is a single-node replica
set named `rs0` (required for transactions) and `mongo-init` initiates it
automatically; wait until `mongo` is healthy before running the index sync.
Because the replica set advertises `mongo:27017`, add `127.0.0.1 mongo` to your
hosts file when running the API on the host with the `localhost` URL from
`.env.example`; the API container uses `mongodb://mongo:27017/...` internally.
Alternatively, use `docker compose up -d api` and let Compose handle it.

Set `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and
`PAYSTACK_SECRET_KEY` in `.env`; the remaining values in `.env.example` are
optional. The application validates the MongoDB connection URL, Redis URL, JWT
secrets, ports, token lifetimes, bcrypt rounds, the flat delivery fee/currency,
and Paystack URLs on startup. `REDIS_URL` is required when `NODE_ENV` is
`production`; when it is omitted in development the API falls back to
single-instance mode. Public registration creates customer accounts; riders and
admins are provisioned separately.

For local payment testing use a Paystack test secret key (`sk_test_...`).
`PAYSTACK_API_BASE_URL` defaults to `https://api.paystack.co`, and
`PAYSTACK_CALLBACK_URL` can point back to the customer-facing application.
Paystack signs webhooks with the same secret key.

Notifications are persisted before delivery and retried asynchronously. Set
`SMTP_HOST` (plus `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and
`SMTP_FROM`) to enable email delivery. When `SMTP_HOST` is unset, email is
disabled but in-app notifications are still stored and marked as sent.

## API conventions

- REST endpoints use the `/api/v1` prefix; Swagger UI is available at `/api/docs`.
- Resource collections use plural names, with resource identifiers in path segments.
- Request bodies are validated and transformed. Unknown properties are rejected.
- Use NestJS HTTP status codes and exception responses; successful resource
  creation should return `201 Created`.
- Every response includes an `x-request-id` header. Incoming values are
  propagated; otherwise a UUID is generated for request correlation.
- Authentication, payment, and webhook routes are rate limited. Exceeding a
  limit returns `429 Too Many Requests`.
- Document endpoint behavior and DTOs with Swagger decorators as domain routes
  are added.

## Implemented endpoints

- `POST /api/v1/auth/register`, `/login`, `/refresh`, `/logout`
- `GET /api/v1/users/me`, `PATCH /api/v1/users/me`
- `POST /api/v1/orders`
- `GET /api/v1/orders`, `/orders/:id`, `/orders/:id/history`
- `POST /api/v1/orders/:id/cancel`
- `POST /api/v1/orders/:id/payments`
- `GET /api/v1/payments/:id`
- `POST /api/v1/payments/verify`
- `POST /api/v1/payments/webhook`
- `GET /api/v1/deliveries/assigned`, `/deliveries/:id`
- `GET /api/v1/deliveries/:id/tracking`
- `POST /api/v1/deliveries/:id/location`
- `POST /api/v1/deliveries/:id/accept`, `/reject`, `/pickup`, `/start`,
  `/complete`, `/fail`
- `GET /api/v1/admin/orders`
- `GET /api/v1/admin/payments`
- `POST /api/v1/admin/orders/:id/assign`, `/admin/deliveries/:id/reassign`
- `GET /api/v1/admin/riders`, `/admin/customers`
- `PATCH /api/v1/admin/users/:id/status`
- `GET /api/v1/admin/dashboard`
- `GET /api/v1/admin/riders/performance`
- `GET /api/v1/admin/riders/:id/performance`
- `GET /api/v1/notifications`
- `GET /api/v1/health`, `/health/ready`

Authenticated requests use a bearer access token. Refresh tokens are rotated on
use and revoked on logout. Order fees and currency come from
`DEFAULT_DELIVERY_FEE` and `DEFAULT_CURRENCY`; customers cannot submit pricing.
Only administrators can assign active riders, and only confirmed orders are
eligible for assignment. Delivery status changes enforce the order of rider
milestones and are recorded in delivery and assignment history.

Customers initiate one pending Paystack payment per order. Payment success is
only accepted from Paystack verification or a webhook with a valid
`x-paystack-signature`; client redirects cannot confirm payment. Verified
successful payments are idempotent, set `paidAt`, and move the order from
`PENDING_PAYMENT` to `CONFIRMED`, which makes it eligible for rider assignment.
Failed attempts leave the order pending and allow a new attempt.

Assigned riders can submit location updates while a delivery is `ACCEPTED`,
`PICKED_UP`, or `IN_TRANSIT`. The tracking endpoint returns the latest location,
recent location history, and status history to the customer, assigned rider, and
administrators. Socket.IO clients connect to the `/tracking` namespace with
their access token in the `auth.token` handshake field, or as a bearer
`Authorization` header, and join a delivery room with
`delivery:join` (`{ "deliveryId": "..." }`). Server events include
`delivery:assigned`, `delivery:status_updated`, `delivery:location_updated`,
`delivery:completed`, and `delivery:failed`.

Notifications are written to an outbox transactionally with the business change
that triggers them, then dispatched asynchronously with up to three attempts and
exponential backoff. BullMQ workers let any replica process delivery jobs, and a
repeatable sweep enqueues due notifications. A database claim makes duplicate
jobs harmless; notifications are marked `FAILED` only after the final attempt.
When Redis is not configured the API falls back to in-process retries.
`GET /api/v1/notifications` supports
pagination and optional `status` and `type` filters. Order creation, payment
confirmation, rider assignment, and delivery milestones create notifications for
the affected customer and rider.

Administrators can list and filter orders, payment records, customers, and
riders, and can activate or deactivate customer and rider accounts. Deactivating
an account revokes its refresh tokens and immediately invalidates authenticated
requests; riders with active deliveries cannot be deactivated. Account changes
and delivery assignments are written to structured audit logs.

Administrators can retrieve platform totals from `/admin/dashboard`, including
order and delivery status counts, confirmed payment revenue, seven-day activity,
and rider availability. Rider performance profiles report assignment history,
active workload, completed and failed jobs, completion rate, average acceptance
time, average pickup-to-delivery time, last delivery time, and recent jobs. The
performance list supports `isActive`, `page`, `limit`, `sort`, and `order`
query parameters.

## Security and observability

- Helmet security headers and strict request validation are enabled.
- Rate limits are configurable with `THROTTLE_*`, `AUTH_THROTTLE_*`,
  `PAYMENT_THROTTLE_*`, and `WEBHOOK_THROTTLE_*` environment variables. Counters
  live in Redis and are shared across replicas; when Redis is unreachable the
  guard falls back to per-instance counters and pauses Redis probes for five
  seconds to avoid per-request timeouts.
- `TRUST_PROXY=true` should be set when running behind a reverse proxy so client
  IP addresses and rate limiting are correct.
- Requests are logged as structured JSON with correlation IDs. Set `LOG_LEVEL`
  to `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`.
- Authorization, cookie, webhook signature, and set-cookie headers are redacted.
- Administrative assignment and account-status changes produce audit events.

## Scaling

The API is stateless and can run as multiple replicas behind a load balancer.
Redis provides the shared state that horizontal scaling requires:

- **Rate limiting** uses an atomic Redis script, so limits apply across replicas.
- **Socket.IO** uses `@socket.io/redis-adapter`, so `delivery:*` events reach
  clients connected to any instance. The gateway only accepts the `websocket`
  transport; if you re-enable HTTP polling, configure sticky sessions at the
  load balancer.
- **Notifications** use BullMQ workers and a repeatable sweep job. Delivery is
  idempotent through an atomic MongoDB claim, so duplicate jobs send at most
  once. The MongoDB outbox remains the source of truth, so Redis loss never
  loses notifications.
- **Readiness** (`/api/v1/health/ready`) checks both MongoDB and Redis.

Redis must allow `maxmemory-policy noeviction` for BullMQ; the Compose and
Render configurations set this. Use `rediss://` for managed Redis over TLS.
`NOTIFICATION_WORKER_CONCURRENCY` controls jobs processed per replica (default
`5`). As traffic grows, MongoDB becomes the next bottleneck; tune the Mongoose
connection pool and add read replicas for read-heavy admin endpoints.

## Deployment

`render.yaml` describes a Render web service and Redis instance; MongoDB is
provided by MongoDB Atlas. It builds with
`npm ci --include=dev && npm run build` and uses `/api/v1/health/ready` for
health checks. Set the secrets marked `sync: false` in the Render dashboard:

- `DATABASE_URL` (an Atlas `mongodb+srv://.../delivery_tracking` URI)
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (at least 32 characters each)
- `PAYSTACK_SECRET_KEY`, `PAYSTACK_CALLBACK_URL`
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`

### MongoDB Atlas production notes

- Use an Atlas M10+ cluster (or any replica set): transactions and the
  transactional outbox require a replica set, so a standalone MongoDB will not
  work. Allow the Render egress IPs (or use PrivateLink) and grant the Atlas
  database user read/write access to `delivery_tracking`.
- Run `npm run db:sync:indexes` as a release step with `DATABASE_URL` pointed at
  Atlas. Mongoose models define the indexes; the application does not create
  them at startup.

Production notes:

- Configure the Paystack webhook URL as
  `https://<your-host>/api/v1/payments/webhook`.
- Verify `/api/v1/health` and `/api/v1/health/ready` after deployment.
- The repository is not deployed by CI. CI validates formatting, linting,
  builds, tests, index sync, and the Docker image only.

## Useful commands

| Command                     | Purpose                                  |
| --------------------------- | ---------------------------------------- |
| `npm run build`             | Compile the API                          |
| `npm run lint`              | Lint source and tests                    |
| `npm run format:check`      | Check Prettier formatting                |
| `npm test`                  | Run unit tests                           |
| `npm run test:e2e`          | Run API end-to-end tests                 |
| `npm run db:sync:indexes`   | Create or update MongoDB indexes         |

The project requirements and planned domain behavior are documented in
[`docs/Technical Specification For Delivery and Order Tracking System.pdf`](docs/Technical%20Specification%20For%20Delivery%20and%20Order%20Tracking%20System.pdf).
