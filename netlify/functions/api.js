import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-netlify-env';
const DB_URL = process.env.NETLIFY_DB_URL || process.env.DATABASE_URL || '';
const sql = DB_URL ? neon(DB_URL) : null;

let initialized = false;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
});

function getUser(event) {
  const h = event.headers.authorization || event.headers.Authorization;
  if (!h) return null;
  try { return jwt.verify(h.replace(/^Bearer\s+/, ''), JWT_SECRET); }
  catch { return null; }
}

/* ---------- One-time init ---------- */
async function ensureInit() {
  if (initialized) return;
  await sql`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    cash NUMERIC DEFAULT 1000,
    is_admin BOOLEAN DEFAULT FALSE,
    is_bot BOOLEAN DEFAULT FALSE,
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS cities (
    id SERIAL PRIMARY KEY,
    owner_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    name TEXT DEFAULT 'New City',
    population INTEGER DEFAULT 1,
    buildings INTEGER DEFAULT 0
  )`;
  await sql`CREATE TABLE IF NOT EXISTS stocks (
    ticker TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price NUMERIC DEFAULT 100,
    prev_close NUMERIC DEFAULT 100
  )`;
  await sql`CREATE TABLE IF NOT EXISTS holdings (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    ticker TEXT REFERENCES stocks(ticker) ON DELETE CASCADE,
    shares NUMERIC DEFAULT 0,
    avg_entry NUMERIC DEFAULT 0,
    PRIMARY KEY (user_id, ticker)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS elections (
    id SERIAL PRIMARY KEY,
    is_active BOOLEAN DEFAULT TRUE,
    ends_at TIMESTAMPTZ,
    winner_id INTEGER REFERENCES users(id),
    winner_username TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS votes (
    id SERIAL PRIMARY KEY,
    election_id INTEGER REFERENCES elections(id) ON DELETE CASCADE,
    voter_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    candidate_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(election_id, voter_id)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS market_state (
    id INTEGER PRIMARY KEY DEFAULT 1,
    last_tick TIMESTAMPTZ DEFAULT NOW(),
    CHECK (id = 1)
  )`;
  await sql`INSERT INTO market_state (id) VALUES (1) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO stocks (ticker, name, price, prev_close) VALUES
    ('NVDA','NVIDIA',144.80,139.20),
    ('TSM','TSMC',33.12,32.35),
    ('AMD','AMD',164.20,159.80),
    ('INTC','Intel',23.40,24.85),
    ('AAPL','Apple',234.60,231.90),
    ('ASML','ASML',781.00,763.00),
    ('MSFT','Microsoft',425.10,419.00),
    ('GOOGL','Alphabet',179.40,176.20)
    ON CONFLICT (ticker) DO NOTHING`;

  // Seed bots
  const botNames = ['RobotTrader','QuantBot','AIBotAlpha','WhaleBot','HedgeBot'];
  for (const name of botNames) {
    const ex = await sql`SELECT id FROM users WHERE username = ${name}`;
    if (!ex.length) {
      const hash = await bcrypt.hash(Math.random().toString(36), 4);
      const [bot] = await sql`INSERT INTO users (username, password_hash, cash, is_bot, last_seen)
        VALUES (${name}, ${hash}, ${5000 + Math.floor(Math.random()*5000)}, TRUE, NOW()) RETURNING id`;
      await sql`INSERT INTO cities (owner_id, name, population, buildings)
        VALUES (${bot.id}, ${name + "'s City"}, ${50 + Math.floor(Math.random()*500)}, ${5 + Math.floor(Math.random()*50)})`;
    }
  }

  // Seed first election if none
  const active = await sql`SELECT id FROM elections WHERE is_active = TRUE`;
  if (!active.length) {
    await sql`INSERT INTO elections (is_active, ends_at) VALUES (TRUE, NOW() + INTERVAL '5 minutes')`;
  }

  initialized = true;
}

/* ---------- Background ticks ---------- */
async function tickMarket() {
  const [ms] = await sql`SELECT last_tick FROM market_state WHERE id = 1`;
  if (!ms) return;
  const elapsed = Date.now() - new Date(ms.last_tick).getTime();
  if (elapsed < 30000) return;
  await sql`UPDATE stocks SET prev_close = price,
    price = GREATEST(1, ROUND(price * (1 + (RANDOM()-0.5)*0.02)::numeric, 4))`;
  await sql`UPDATE market_state SET last_tick = NOW() WHERE id = 1`;
}

async function tickElections() {
  const [el] = await sql`SELECT * FROM elections WHERE is_active = TRUE ORDER BY id DESC LIMIT 1`;
  if (!el) {
    if (Math.random() < 0.05) {
      await sql`INSERT INTO elections (is_active, ends_at) VALUES (TRUE, NOW() + INTERVAL '5 minutes')`;
    }
    return;
  }
  if (new Date(el.ends_at) > new Date()) return;
  const votes = await sql`SELECT candidate_id, COUNT(*) as cnt FROM votes
    WHERE election_id = ${el.id} GROUP BY candidate_id ORDER BY cnt DESC LIMIT 1`;
  if (votes.length) {
    const winnerId = votes[0].candidate_id;
    const [w] = await sql`SELECT username FROM users WHERE id = ${winnerId}`;
    await sql`UPDATE elections SET is_active = FALSE, winner_id = ${winnerId}, winner_username = ${w?.username || '?'} WHERE id = ${el.id}`;
    await sql`UPDATE users SET cash = cash + 500 WHERE id = ${winnerId}`;
  } else {
    await sql`UPDATE elections SET is_active = FALSE WHERE id = ${el.id}`;
  }
}

async function tickBots() {
  const bots = await sql`SELECT * FROM users WHERE is_bot = TRUE`;
  for (const bot of bots) {
    await sql`UPDATE users SET last_seen = NOW() WHERE id = ${bot.id}`;
    if (Math.random() < 0.25) {
      // trade
      const [stock] = await sql`SELECT * FROM stocks ORDER BY RANDOM() LIMIT 1`;
      const [user] = await sql`SELECT cash FROM users WHERE id = ${bot.id}`;
      const shares = Math.floor(Math.random() * 5) + 1;
      const total = stock.price * shares;
      if (user.cash >= total) {
        await sql`UPDATE users SET cash = cash - ${total} WHERE id = ${bot.id}`;
        const [h] = await sql`SELECT * FROM holdings WHERE user_id = ${bot.id} AND ticker = ${stock.ticker}`;
        if (h) {
          const newAvg = (h.avg_entry * h.shares + total) / (h.shares + shares);
          await sql`UPDATE holdings SET shares = shares + ${shares}, avg_entry = ${newAvg} WHERE user_id = ${bot.id} AND ticker = ${stock.ticker}`;
        } else {
          await sql`INSERT INTO holdings (user_id, ticker, shares, avg_entry) VALUES (${bot.id}, ${stock.ticker}, ${shares}, ${stock.price})`;
        }
      }
    }
    if (Math.random() < 0.12) {
      const msgs = ['gm','to the moon 🚀','buying the dip','diamond hands 💎','vote for me!','my city is growing 🏙️','wen lambo'];
      const msg = msgs[Math.floor(Math.random() * msgs.length)];
      await sql`INSERT INTO chat_messages (user_id, username, body) VALUES (${bot.id}, ${bot.username}, ${msg})`;
    }
  }
}

/* ---------- Handler ---------- */
export default async (event) => {
  try {
    if (!sql) return json({ error: 'Database not configured. Create a Netlify Database and redeploy.' }, 500);
    await ensureInit();

    const rawPath = event.path || '';
    const path = rawPath.replace('/.netlify/functions/api', '').replace(/^\/api/, '') || '/';
    const method = event.httpMethod;
    const body = event.body ? JSON.parse(event.body) : {};

    // Run background ticks on every request
    await tickMarket();
    await tickElections();
    await tickBots();

    /* ----- AUTH ----- */
    if (path === '/auth/register' && method === 'POST') {
      const { username, password } = body;
      const u = (username || '').toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(u)) return json({ error: 'Username must be 3-20 chars a-z 0-9 _' }, 400);
      if (!password || password.length < 6) return json({ error: 'Password must be 6+ chars' }, 400);
      const ex = await sql`SELECT id FROM users WHERE username = ${u}`;
      if (ex.length) return json({ error: 'Username taken' }, 400);
      const hash = await bcrypt.hash(password, 10);
      const isAdmin = u === 'sidd';
      const [newUser] = await sql`INSERT INTO users (username, password_hash, cash, is_admin, last_seen)
        VALUES (${u}, ${hash}, 1000, ${isAdmin}, NOW())
        RETURNING id, username, cash, is_admin`;
      await sql`INSERT INTO cities (owner_id, name) VALUES (${newUser.id}, ${u + "'s City"})`;
      const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });
      return json({ token, user: newUser });
    }

    if (path === '/auth/login' && method === 'POST') {
      const u = (body.username || '').toLowerCase();
      const [user] = await sql`SELECT * FROM users WHERE username = ${u}`;
      if (!user) return json({ error: 'Invalid credentials' }, 401);
      const ok = await bcrypt.compare(body.password || '', user.password_hash);
      if (!ok) return json({ error: 'Invalid credentials' }, 401);
      await sql`UPDATE users SET last_seen = NOW() WHERE id = ${user.id}`;
      const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
      return json({ token, user: { id: user.id, username: user.username, cash: user.cash, is_admin: user.is_admin } });
    }

    /* ----- AUTH REQUIRED ----- */
    const auth = getUser(event);
    if (!auth) return json({ error: 'Unauthorized' }, 401);
    await sql`UPDATE users SET last_seen = NOW() WHERE id = ${auth.id}`;

    if (path === '/me' && method === 'GET') {
      const [user] = await sql`SELECT id, username, cash, is_admin FROM users WHERE id = ${auth.id}`;
      const [city] = await sql`SELECT * FROM cities WHERE owner_id = ${auth.id}`;
      return json({ user, city });
    }

    if (path === '/players' && method === 'GET') {
      const rows = await sql`SELECT id, username, cash, is_bot, is_admin,
        (last_seen > NOW() - INTERVAL '30 seconds') as is_online
        FROM users ORDER BY last_seen DESC`;
      return json(rows);
    }

    if (path === '/stocks' && method === 'GET') {
      return json(await sql`SELECT * FROM stocks ORDER BY ticker`);
    }

    if (path === '/holdings' && method === 'GET') {
      return json(await sql`SELECT h.ticker, h.shares, h.avg_entry, s.price as current_price, s.name
        FROM holdings h JOIN stocks s ON h.ticker = s.ticker WHERE h.user_id = ${auth.id}`);
    }

    if (path === '/trade' && method === 'POST') {
      const { ticker, side, shares } = body;
      if (!shares || shares <= 0) return json({ error: 'Invalid quantity' }, 400);
      if (!['BUY','SELL'].includes(side)) return json({ error: 'Invalid side' }, 400);
      const [stock] = await sql`SELECT price FROM stocks WHERE ticker = ${ticker}`;
      if (!stock) return json({ error: 'Unknown ticker' }, 400);
      const [user] = await sql`SELECT cash FROM users WHERE id = ${auth.id}`;
      const total = stock.price * shares;
      const fee = total * 0.001;
      if (side === 'BUY') {
        if (user.cash < total + fee) return json({ error: 'Insufficient cash' }, 400);
        await sql`UPDATE users SET cash = cash - ${total + fee} WHERE id = ${auth.id}`;
        const [h] = await sql`SELECT * FROM holdings WHERE user_id = ${auth.id} AND ticker = ${ticker}`;
        if (h) {
          const newAvg = (h.avg_entry * h.shares + total) / (h.shares + shares);
          await sql`UPDATE holdings SET shares = shares + ${shares}, avg_entry = ${newAvg} WHERE user_id = ${auth.id} AND ticker = ${ticker}`;
        } else {
          await sql`INSERT INTO holdings (user_id, ticker, shares, avg_entry) VALUES (${auth.id}, ${ticker}, ${shares}, ${stock.price})`;
        }
      } else {
        const [h] = await sql`SELECT shares FROM holdings WHERE user_id = ${auth.id} AND ticker = ${ticker}`;
        if (!h || h.shares < shares) return json({ error: 'Insufficient shares' }, 400);
        await sql`UPDATE users SET cash = cash + ${total - fee} WHERE id = ${auth.id}`;
        if (h.shares == shares) await sql`DELETE FROM holdings WHERE user_id = ${auth.id} AND ticker = ${ticker}`;
        else await sql`UPDATE holdings SET shares = shares - ${shares} WHERE user_id = ${auth.id} AND ticker = ${ticker}`;
      }
      return json({ price: stock.price, total, fee });
    }

    if (path === '/build' && method === 'POST') {
      const [user] = await sql`SELECT cash FROM users WHERE id = ${auth.id}`;
      if (user.cash < 100) return json({ error: 'Need $100 to build' }, 400);
      await sql`UPDATE users SET cash = cash - 100 WHERE id = ${auth.id}`;
      await sql`UPDATE cities SET population = population + 10, buildings = buildings + 1 WHERE owner_id = ${auth.id}`;
      const [city] = await sql`SELECT * FROM cities WHERE owner_id = ${auth.id}`;
      return json(city);
    }

    if (path === '/chat' && method === 'GET') {
      const msgs = await sql`SELECT username, body, created_at FROM chat_messages ORDER BY created_at DESC LIMIT 50`;
      return json(msgs.reverse());
    }

    if (path === '/chat' && method === 'POST') {
      const msg = (body.body || '').trim();
      if (!msg || msg.length > 200) return json({ error: 'Message must be 1-200 chars' }, 400);
      await sql`INSERT INTO chat_messages (user_id, username, body) VALUES (${auth.id}, ${auth.username}, ${msg})`;
      return json({ success: true });
    }

    if (path === '/election' && method === 'GET') {
      const [el] = await sql`SELECT * FROM elections WHERE is_active = TRUE ORDER BY id DESC LIMIT 1`;
      if (!el) {
        const [last] = await sql`SELECT * FROM elections WHERE is_active = FALSE ORDER BY id DESC LIMIT 1`;
        return json({ active: false, last });
      }
      const voteRows = await sql`SELECT candidate_id, COUNT(*) as count FROM votes
        WHERE election_id = ${el.id} GROUP BY candidate_id ORDER BY count DESC`;
      const candidates = [];
      for (const v of voteRows) {
        const [u] = await sql`SELECT username FROM users WHERE id = ${v.candidate_id}`;
        candidates.push({ user_id: v.candidate_id, username: u?.username || '?', votes: parseInt(v.count) });
      }
      const [myVote] = await sql`SELECT candidate_id FROM votes WHERE election_id = ${el.id} AND voter_id = ${auth.id}`;
      return json({ active: true, election: el, candidates, my_vote: myVote?.candidate_id || null });
    }

    if (path === '/vote' && method === 'POST') {
      const [el] = await sql`SELECT * FROM elections WHERE is_active = TRUE ORDER BY id DESC LIMIT 1`;
      if (!el) return json({ error: 'No active election' }, 400);
      const ex = await sql`SELECT id FROM votes WHERE election_id = ${el.id} AND voter_id = ${auth.id}`;
      if (ex.length) return json({ error: 'Already voted' }, 400);
      await sql`INSERT INTO votes (election_id, voter_id, candidate_id) VALUES (${el.id}, ${auth.id}, ${body.candidate_id})`;
      return json({ success: true });
    }

    /* ----- ADMIN ----- */
    if (path.startsWith('/admin')) {
      const [meRow] = await sql`SELECT is_admin FROM users WHERE id = ${auth.id}`;
      if (!meRow?.is_admin) return json({ error: 'Admin only' }, 403);
      if (path === '/admin/grant' && method === 'POST') {
        await sql`UPDATE users SET cash = cash + ${body.amount} WHERE username = ${(body.username || '').toLowerCase()}`;
        return json({ success: true });
      }
      if (path === '/admin/start-election' && method === 'POST') {
        await sql`UPDATE elections SET is_active = FALSE WHERE is_active = TRUE`;
        await sql`INSERT INTO elections (is_active, ends_at) VALUES (TRUE, NOW() + INTERVAL '5 minutes')`;
        return json({ success: true });
      }
    }

    return json({ error: 'Not found', path, method }, 404);
  } catch (err) {
    console.error('API error:', err);
    return json({ error: err.message || 'Server error' }, 500);
  }
};
