# Flash Sale Store API

A small Node.js API for browsing products, placing orders, and viewing a user's orders. SQLite transactions and a conditional stock decrement prevent overselling; order creation also requires an idempotency key.

## Requirements

- Node.js 22.5 or newer (for built-in SQLite support)

## Run

```sh
npm install
npm start
```

The API listens on `http://localhost:3000`. The first run creates `store.sqlite` and seeds three sample products. Set `PORT` or `STORE_DB_PATH` to override the defaults.

## Endpoints

- `GET /` lists the available API routes.
- `GET /products` lists products and available stock.
- `GET /products/:productId` returns one product and its available stock.
- `POST /orders` creates an order. Send `Idempotency-Key` and JSON with `userId`, `productId`, and `quantity`.
- `GET /users/:userId/orders` lists that user's orders.
- `GET /users/:userId/orders/:orderId` returns one of that user's orders.

Example order:

```sh
curl -i http://localhost:3000/orders \
  -H 'content-type: application/json' \
  -H 'idempotency-key: checkout-123' \
  -d '{"userId":"customer-1","productId":1,"quantity":1}'
```

A successful new order returns `201`; a replay of the same key and payload returns the original order with `200`. Reusing a key for a different payload returns `409`. Insufficient stock returns `409` and does not create an order. `userId` is a demo identifier, not authentication; a production deployment must derive ownership from authenticated identity and add appropriate request, rate, and operational controls.

## Tests

```sh
npm test
```