const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MAX_BODY_BYTES = 16 * 1024;

function runTransaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function initializeDatabase(db) {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      stock INTEGER NOT NULL CHECK (stock >= 0)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      PRIMARY KEY (user_id, key)
    );
  `);

  const productCount = db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
  if (productCount === 0) {
    const addProduct = db.prepare(
      'INSERT INTO products (name, description, price_cents, stock) VALUES (?, ?, ?, ?)'
    );
    runTransaction(db, () => {
      addProduct.run('Everyday Backpack', 'Water-resistant 20L backpack', 5499, 24);
      addProduct.run('Insulated Bottle', 'Stainless steel, 750ml', 2199, 12);
      addProduct.run('Desk Lamp', 'Dimmable LED task lamp', 3899, 6);
    });
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large'), { status: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function createStoreServer({ dbPath = path.join(process.cwd(), 'store.sqlite') } = {}) {
  const db = new DatabaseSync(dbPath);
  initializeDatabase(db);

  const getOrder = db.prepare(`
    SELECT o.id, o.user_id AS userId, o.product_id AS productId,
      p.name AS productName, o.quantity, o.created_at AS createdAt
    FROM orders o JOIN products p ON p.id = o.product_id
    WHERE o.id = ?
  `);
  const createOrder = (userId, productId, quantity, key, requestHash) => runTransaction(db, () => {
    const previous = db.prepare(
      'SELECT request_hash AS requestHash, order_id AS orderId FROM idempotency_keys WHERE user_id = ? AND key = ?'
    ).get(userId, key);

    if (previous) {
      if (previous.requestHash !== requestHash) {
        return { conflict: true };
      }
      return { order: getOrder.get(previous.orderId), replayed: true };
    }

    const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
    if (!product) {
      return { notFound: true };
    }

    const stockUpdate = db.prepare(
      'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?'
    ).run(quantity, productId, quantity);
    if (stockUpdate.changes !== 1) {
      return { soldOut: true };
    }

    const orderResult = db.prepare(
      'INSERT INTO orders (user_id, product_id, quantity) VALUES (?, ?, ?)'
    ).run(userId, productId, quantity);
    const orderId = Number(orderResult.lastInsertRowid);

    db.prepare(
      'INSERT INTO idempotency_keys (user_id, key, request_hash, order_id) VALUES (?, ?, ?, ?)'
    ).run(userId, key, requestHash, orderId);

    return { order: getOrder.get(orderId), replayed: false };
  });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    try {
      if (request.method === 'GET' && segments.length === 0) {
        return sendJson(response, 200, {
          name: 'Flash Sale Store API',
          routes: {
            products: 'GET /products',
            product: 'GET /products/:productId',
            createOrder: 'POST /orders',
            userOrders: 'GET /users/:userId/orders',
            userOrder: 'GET /users/:userId/orders/:orderId'
          }
        });
      }

      if (request.method === 'GET' && segments.length === 1 && segments[0] === 'products') {
        const products = db.prepare(
          'SELECT id, name, description, price_cents AS priceCents, stock AS availableStock FROM products ORDER BY id'
        ).all();
        return sendJson(response, 200, { products });
      }

      if (request.method === 'GET' && segments.length === 2 && segments[0] === 'products') {
        const productId = Number(segments[1]);
        const product = Number.isSafeInteger(productId) && productId > 0
          ? db.prepare(
            'SELECT id, name, description, price_cents AS priceCents, stock AS availableStock FROM products WHERE id = ?'
          ).get(productId)
          : null;
        if (!product) return sendJson(response, 404, { error: 'Product not found' });
        return sendJson(response, 200, { product });
      }

      if (request.method === 'POST' && segments.length === 1 && segments[0] === 'orders') {
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || key.trim().length === 0 || key.length > 200) {
          return sendJson(response, 400, { error: 'A valid Idempotency-Key header is required' });
        }

        const body = await readJsonBody(request);
        const { userId, productId, quantity } = body ?? {};
        if (typeof userId !== 'string' || userId.trim().length === 0 || userId.length > 200 ||
            !Number.isSafeInteger(productId) || productId < 1 ||
            !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
          return sendJson(response, 400, {
            error: 'userId, a positive productId, and quantity from 1 to 100 are required'
          });
        }

        const requestHash = JSON.stringify({ productId, quantity });
        const result = createOrder(userId, productId, quantity, key, requestHash);
        if (result.conflict) {
          return sendJson(response, 409, { error: 'Idempotency-Key was already used with a different request' });
        }
        if (result.notFound) return sendJson(response, 404, { error: 'Product not found' });
        if (result.soldOut) return sendJson(response, 409, { error: 'Insufficient stock' });

        return sendJson(response, result.replayed ? 200 : 201, {
          order: result.order,
          replayed: result.replayed
        });
      }

      if (request.method === 'GET' && segments.length === 3 && segments[0] === 'users' && segments[2] === 'orders') {
        const orders = db.prepare(`
          SELECT o.id, o.user_id AS userId, o.product_id AS productId,
            p.name AS productName, o.quantity, o.created_at AS createdAt
          FROM orders o JOIN products p ON p.id = o.product_id
          WHERE o.user_id = ? ORDER BY o.id DESC
        `).all(segments[1]);
        return sendJson(response, 200, { orders });
      }

      if (request.method === 'GET' && segments.length === 4 && segments[0] === 'users' && segments[2] === 'orders') {
        const orderId = Number(segments[3]);
        const order = Number.isSafeInteger(orderId) && orderId > 0
          ? getOrder.get(orderId)
          : null;
        if (!order || order.userId !== segments[1]) return sendJson(response, 404, { error: 'Order not found' });
        return sendJson(response, 200, { order });
      }

      return sendJson(response, 404, { error: 'Route not found' });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        return sendJson(response, error.status ?? 500, {
          error: error.status ? error.message : 'Internal server error'
        });
      }
    }
  });

  return { server, db, close: () => db.close() };
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  const dbPath = process.env.STORE_DB_PATH ?? path.join(process.cwd(), 'store.sqlite');
  const app = createStoreServer({ dbPath });
  app.server.listen(port, () => {
    console.log(`Store API listening on http://localhost:${port}`);
  });
}

module.exports = { createStoreServer };