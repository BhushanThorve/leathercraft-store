const express  = require('express');
const { Pool } = require('pg');
const cors     = require('cors');
const path     = require('path');
const crypto   = require('crypto');

function hashPassword(password, salt) {
  return crypto.createHmac('sha256', salt).update(password).digest('hex');
}
function genSalt() { return crypto.randomBytes(24).toString('hex'); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
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
app.use(express.static(path.join(__dirname)));

// ── Database Setup ────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set. Make sure the Render PostgreSQL database is linked.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB(retries = 10, delay = 5000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query('SELECT 1'); // test connection
      break;
    } catch (err) {
      if (i === retries) throw err;
      console.log(`⏳ DB not ready (attempt ${i}/${retries}), retrying in ${delay/1000}s…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id         SERIAL PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT UNIQUE NOT NULL,
      phone      TEXT,
      address    TEXT,
      city       TEXT,
      country    TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id         SERIAL PRIMARY KEY,
      user_name  TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_phone TEXT,
      address    TEXT,
      city       TEXT,
      country    TEXT,
      total      NUMERIC NOT NULL,
      status     TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id         SERIAL PRIMARY KEY,
      order_id   INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL,
      name       TEXT NOT NULL,
      price      NUMERIC NOT NULL,
      qty        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      email        TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt         TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ Database initialised');
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/subscribe
app.post('/api/subscribe', async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required.' });
  }
  try {
    await pool.query('INSERT INTO subscribers (email) VALUES ($1)', [email]);
    res.json({ message: 'Subscribed successfully!' });
  } catch {
    res.status(409).json({ error: 'Email already subscribed.' });
  }
});

// GET /api/subscribers (admin)
app.get('/api/subscribers', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM subscribers ORDER BY created_at DESC');
  res.json(rows);
});

// POST /api/orders
app.post('/api/orders', async (req, res) => {
  const { name, email, phone, address, city, country, cart } = req.body;
  if (!name || !email || !cart || !Object.keys(cart).length) {
    return res.status(400).json({ error: 'Name, email and cart are required.' });
  }

  const total = Object.values(cart).reduce((sum, item) => sum + item.price * item.qty, 0);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [order] } = await client.query(
      `INSERT INTO orders (user_name, user_email, user_phone, address, city, country, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [name, email, phone || null, address || null, city || null, country || null, total]
    );
    const orderId = order.id;

    for (const [productId, item] of Object.entries(cart)) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES ($1,$2,$3,$4,$5)`,
        [orderId, +productId, item.name, item.price, item.qty]
      );
    }

    await client.query(
      `INSERT INTO users (name, email, phone, address, city, country)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (email) DO UPDATE SET
         name    = EXCLUDED.name,
         phone   = COALESCE(EXCLUDED.phone, users.phone),
         address = COALESCE(EXCLUDED.address, users.address),
         city    = COALESCE(EXCLUDED.city, users.city),
         country = COALESCE(EXCLUDED.country, users.country)`,
      [name, email, phone || null, address || null, city || null, country || null]
    );

    await client.query('COMMIT');
    res.json({ message: 'Order placed!', orderId, total });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Order failed. Please try again.' });
  } finally {
    client.release();
  }
});

// GET /api/orders (admin)
app.get('/api/orders', async (req, res) => {
  const { rows: orders } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
  const { rows: items }  = await pool.query('SELECT * FROM order_items');
  const result = orders.map(o => ({ ...o, items: items.filter(i => i.order_id === o.id) }));
  res.json(result);
});

// GET /api/users (admin)
app.get('/api/users', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
  res.json(rows);
});

// POST /api/auth/signup
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const salt = genSalt();
  const hash = hashPassword(password, salt);
  try {
    const { rows: [account] } = await pool.query(
      `INSERT INTO accounts (name, email, password_hash, salt)
       VALUES ($1, $2, $3, $4) RETURNING id, name, email, created_at`,
      [name.trim(), email.toLowerCase().trim(), hash, salt]
    );
    res.json({ message: 'Account created!', user: { id: account.id, name: account.name, email: account.email } });
  } catch {
    res.status(409).json({ error: 'An account with this email already exists.' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  const { rows } = await pool.query(
    'SELECT * FROM accounts WHERE email = $1',
    [email.toLowerCase().trim()]
  );
  const account = rows[0];
  if (!account) {
    return res.status(401).json({ error: 'No account found with this email.' });
  }
  const hash = hashPassword(password, account.salt);
  if (hash !== account.password_hash) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  res.json({ message: 'Logged in!', user: { id: account.id, name: account.name, email: account.email } });
});

// DELETE /api/admin/reset — wipe all data and reset ID sequences
app.delete('/api/admin/reset', async (req, res) => {
  await pool.query(`
    TRUNCATE order_items, orders, users, subscribers RESTART IDENTITY CASCADE;
  `);
  res.json({ message: 'All data cleared.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running → http://localhost:${PORT}`);
      console.log(`   GET  /api/users`);
      console.log(`   GET  /api/orders`);
      console.log(`   GET  /api/subscribers`);
    });
  })
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
