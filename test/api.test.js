const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');
const { createStoreServer } = require('../src/server');

let app;
let baseUrl;
let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'store-api-'));
  app = createStoreServer({ dbPath: path.join(tempDir, 'test.sqlite') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
  app.close();
  await rm(tempDir, { recursive: true, force: true });
});

test('concurrent purchases never oversell limited stock', async () => {
  app.db.prepare('UPDATE products SET stock = 5 WHERE id = 1').run();

  const responses = await Promise.all(Array.from({ length: 30 }, (_, index) => fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `flash-${index}` },
    body: JSON.stringify({ userId: `customer-${index}`, productId: 1, quantity: 1 })
  })));

  assert.equal(responses.filter((response) => response.status === 201).length, 5);
  assert.equal(responses.filter((response) => response.status === 409).length, 25);
  assert.equal(app.db.prepare('SELECT stock FROM products WHERE id = 1').get().stock, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 5);
  assert.equal(app.db.prepare('SELECT MIN(stock) AS stock FROM products').get().stock, 0);
});

test('same idempotency key returns the original order without consuming more stock', async () => {
  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'retry-1' },
    body: JSON.stringify({ userId: 'customer-a', productId: 1, quantity: 2 })
  };

  const first = await fetch(`${baseUrl}/orders`, request);
  const firstBody = await first.json();
  const replay = await fetch(`${baseUrl}/orders`, request);
  const replayBody = await replay.json();

  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.order.id, firstBody.order.id);
  assert.equal(app.db.prepare('SELECT stock FROM products WHERE id = 1').get().stock, 22);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1);
});

test('reusing a key with a different payload conflicts and users can view their orders', async () => {
  const createResponse = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'customer-key' },
    body: JSON.stringify({ userId: 'customer-a', productId: 1, quantity: 1 })
  });
  const created = await createResponse.json();

  const conflict = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'customer-key' },
    body: JSON.stringify({ userId: 'customer-a', productId: 1, quantity: 2 })
  });
  assert.equal(conflict.status, 409);

  const listResponse = await fetch(`${baseUrl}/users/customer-a/orders`);
  const list = await listResponse.json();
  assert.equal(list.orders.length, 1);
  assert.equal(list.orders[0].id, created.order.id);

  const detailResponse = await fetch(`${baseUrl}/users/customer-a/orders/${created.order.id}`);
  assert.equal(detailResponse.status, 200);
  const otherUserResponse = await fetch(`${baseUrl}/users/customer-b/orders/${created.order.id}`);
  assert.equal(otherUserResponse.status, 404);
});

test('products are browseable with current stock', async () => {
  const response = await fetch(`${baseUrl}/products`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.products.length, 3);
  assert.equal(body.products[0].availableStock, 24);
});

test('root lists available API routes', async () => {
  const response = await fetch(`${baseUrl}/`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.name, 'Flash Sale Store API');
  assert.equal(body.routes.products, 'GET /products');
});