const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    // In production allow all; locally restrict to localhost + file://
    if (process.env.NODE_ENV === 'production') return callback(null, true);
    if (!origin || origin === 'null' || /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname)));  // serve index.html

// ── Database Setup ────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'store.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    phone         TEXT,
    address       TEXT,
    city          TEXT,
    country       TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name    TEXT NOT NULL,
    user_email   TEXT NOT NULL,
    user_phone   TEXT,
    address      TEXT,
    city         TEXT,
    country      TEXT,
    total        REAL NOT NULL,
    status       TEXT DEFAULT 'pending',
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER NOT NULL,
    name       TEXT NOT NULL,
    price      REAL NOT NULL,
    qty        INTEGER NOT NULL
  );
`);

console.log('✅ Database initialised — store.db');

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/subscribe — newsletter
app.post('/api/subscribe', (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required.' });
  }
  try {
    db.prepare('INSERT INTO subscribers (email) VALUES (?)').run(email);
    res.json({ message: 'Subscribed successfully!' });
  } catch {
    res.status(409).json({ error: 'Email already subscribed.' });
  }
});

// GET /api/subscribers — list all (admin)
app.get('/api/subscribers', (req, res) => {
  const rows = db.prepare('SELECT * FROM subscribers ORDER BY created_at DESC').all();
  res.json(rows);
});

// POST /api/orders — place an order
app.post('/api/orders', (req, res) => {
  const { name, email, phone, address, city, country, cart } = req.body;

  if (!name || !email || !cart || !Object.keys(cart).length) {
    return res.status(400).json({ error: 'Name, email and cart are required.' });
  }

  const total = Object.values(cart).reduce((sum, item) => sum + item.price * item.qty, 0);

  const { lastInsertRowid: orderId } = db.prepare(
    `INSERT INTO orders (user_name, user_email, user_phone, address, city, country, total)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(name, email, phone || null, address || null, city || null, country || null, total);

  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)`
  );
  for (const [productId, item] of Object.entries(cart)) {
    insertItem.run(orderId, +productId, item.name, item.price, item.qty);
  }

  // Upsert user record
  db.prepare(
    `INSERT INTO users (name, email, phone, address, city, country)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name    = excluded.name,
       phone   = coalesce(excluded.phone, phone),
       address = coalesce(excluded.address, address),
       city    = coalesce(excluded.city, city),
       country = coalesce(excluded.country, country)`
  ).run(name, email, phone || null, address || null, city || null, country || null);

  res.json({ message: 'Order placed!', orderId, total });
});

// GET /api/orders — list all orders (admin)
app.get('/api/orders', (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const items  = db.prepare('SELECT * FROM order_items').all();
  const result = orders.map(o => ({ ...o, items: items.filter(i => i.order_id === o.id) }));
  res.json(result);
});

// GET /api/users — list all users (admin)
app.get('/api/users', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  res.json(rows);
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running → http://localhost:${PORT}`);
  console.log(`   Admin APIs:`);
  console.log(`   GET  http://localhost:${PORT}/api/users`);
  console.log(`   GET  http://localhost:${PORT}/api/orders`);
  console.log(`   GET  http://localhost:${PORT}/api/subscribers`);
});
