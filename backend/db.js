// backend/db.js
// Uses Node built-in node:sqlite (Node 22.5+) — no native compilation needed
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
require('dotenv').config();

// On Vercel serverless use /tmp (writable). Locally use current dir.
const DB_PATH = process.env.DB_PATH || (process.env.NODE_ENV === 'production' ? '/tmp/mailsense.db' : './mailsense.db');
const db = new DatabaseSync(path.resolve(DB_PATH));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name  TEXT    NOT NULL,
    last_name   TEXT    NOT NULL,
    email       TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    role        TEXT    NOT NULL DEFAULT 'user',
    agent_mode  TEXT    NOT NULL DEFAULT 'safe',
    is_verified INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS otp_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL,
    code       TEXT    NOT NULL,
    type       TEXT    NOT NULL,
    expires_at TEXT    NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS gmail_tokens (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email     TEXT    NOT NULL UNIQUE,
    access_token   TEXT    NOT NULL,
    refresh_token  TEXT,
    token_expiry   TEXT,
    scope          TEXT,
    connected_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS emails (
    id           TEXT    PRIMARY KEY,
    user_email   TEXT    NOT NULL,
    gmail_id     TEXT    NOT NULL,
    thread_id    TEXT,
    from_addr    TEXT,
    from_name    TEXT,
    subject      TEXT,
    snippet      TEXT,
    body         TEXT,
    tag          TEXT    DEFAULT 'important',
    color        TEXT    DEFAULT '#4f6ef7',
    replied      INTEGER DEFAULT 0,
    archived     INTEGER DEFAULT 0,
    deleted      INTEGER DEFAULT 0,
    email_time   TEXT,
    fetched_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS agent_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT    NOT NULL,
    dot_color  TEXT    NOT NULL DEFAULT 'blue',
    message    TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS agent_stats (
    user_email TEXT    PRIMARY KEY,
    total      INTEGER DEFAULT 0,
    important  INTEGER DEFAULT 0,
    promo      INTEGER DEFAULT 0,
    spam       INTEGER DEFAULT 0,
    replied    INTEGER DEFAULT 0,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── prepare() wrapper — node:sqlite compatible ───────────────
// Detects named-param objects by checking if the SQL uses $name style params.
// This avoids mistaking node:sqlite null-prototype row objects for param objects.
function isNamedParamObject(sql, args) {
  if (args.length !== 1) return false;
  const a = args[0];
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return false;
  // Only treat as named-param object if SQL actually contains named params
  return /[\$@:][a-zA-Z_]/.test(sql);
}

function prepare(sql) {
  const stmt = db.prepare(sql);
  return {
    run(...args) {
      return isNamedParamObject(sql, args) ? stmt.run(args[0]) : stmt.run(...args);
    },
    get(...args) {
      return isNamedParamObject(sql, args) ? stmt.get(args[0]) : stmt.get(...args);
    },
    all(...args) {
      return isNamedParamObject(sql, args) ? stmt.all(args[0]) : stmt.all(...args);
    },
  };
}

// ── Prepared statements ───────────────────────────────────────
const stmts = {
  getUserByEmail:  prepare('SELECT * FROM users WHERE email = ?'),
  createUser:      prepare('INSERT INTO users (first_name, last_name, email, password, role, is_verified) VALUES ($first_name, $last_name, $email, $password, $role, $is_verified)'),
  verifyUser:      prepare('UPDATE users SET is_verified = 1 WHERE email = ?'),
  updatePassword:  prepare('UPDATE users SET password = ? WHERE email = ?'),
  deleteUser:      prepare('DELETE FROM users WHERE email = ?'),
  insertOTP:       prepare('INSERT INTO otp_codes (email, code, type, expires_at) VALUES ($email, $code, $type, $expires_at)'),
  getValidOTP:     prepare("SELECT * FROM otp_codes WHERE email = ? AND type = ? AND used = 0 AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1"),
  markOTPUsed:     prepare('UPDATE otp_codes SET used = 1 WHERE id = ?'),
  getToken:        prepare('SELECT * FROM gmail_tokens WHERE user_email = ?'),
  upsertToken:     prepare('INSERT INTO gmail_tokens (user_email, access_token, refresh_token, token_expiry, scope) VALUES ($user_email, $access_token, $refresh_token, $token_expiry, $scope) ON CONFLICT(user_email) DO UPDATE SET access_token = excluded.access_token, refresh_token = COALESCE(excluded.refresh_token, gmail_tokens.refresh_token), token_expiry = excluded.token_expiry, scope = excluded.scope'),
  deleteToken:     prepare('DELETE FROM gmail_tokens WHERE user_email = ?'),
  upsertEmail:     prepare('INSERT INTO emails (id, user_email, gmail_id, thread_id, from_addr, from_name, subject, snippet, body, tag, color, email_time) VALUES ($id, $user_email, $gmail_id, $thread_id, $from_addr, $from_name, $subject, $snippet, $body, $tag, $color, $email_time) ON CONFLICT(id) DO UPDATE SET tag = excluded.tag, snippet = excluded.snippet, body = excluded.body'),
  getEmails:       prepare('SELECT * FROM emails WHERE user_email = ? AND deleted = 0 ORDER BY fetched_at DESC LIMIT 100'),
  markEmailReplied:prepare('UPDATE emails SET replied = 1 WHERE id = ?'),
  insertLog:       prepare('INSERT INTO agent_logs (user_email, dot_color, message) VALUES (?, ?, ?)'),
  getLogs:         prepare('SELECT * FROM agent_logs WHERE user_email = ? ORDER BY id DESC LIMIT 100'),
  upsertStats:     prepare('INSERT INTO agent_stats (user_email, total, important, promo, spam, replied) VALUES ($user_email, $total, $important, $promo, $spam, $replied) ON CONFLICT(user_email) DO UPDATE SET total = excluded.total, important = excluded.important, promo = excluded.promo, spam = excluded.spam, replied = excluded.replied, updated_at = datetime(\'now\')'),
};

// ── Bulk delete (dynamic IN clause) ──────────────────────────
function markEmailsDeleted(userEmail, emailIds) {
  if (!emailIds.length) return;
  const ph = emailIds.map(() => '?').join(',');
  db.prepare(`UPDATE emails SET deleted = 1 WHERE user_email = ? AND id IN (${ph})`).run(userEmail, ...emailIds);
}

// ── Recompute stats from emails table ────────────────────────
function recomputeStats(userEmail) {
  const rows = db.prepare("SELECT tag, COUNT(*) as cnt FROM emails WHERE user_email = ? AND deleted = 0 GROUP BY tag").all(userEmail);
  const repliedRow = db.prepare("SELECT COUNT(*) as cnt FROM emails WHERE user_email = ? AND replied = 1 AND deleted = 0").get(userEmail);
  const stats = { user_email: userEmail, total: 0, important: 0, promo: 0, spam: 0, replied: repliedRow?.cnt || 0 };
  for (const r of rows) {
    stats.total += r.cnt;
    if (r.tag === 'important') stats.important = r.cnt;
    if (r.tag === 'promo')     stats.promo     = r.cnt;
    if (r.tag === 'spam')      stats.spam      = r.cnt;
  }
  stmts.upsertStats.run(stats);
  return stats;
}

// ── Ad-hoc query helpers (used in routes) ────────────────────
function query(sql, ...params)    { return db.prepare(sql).all(...params); }
function queryOne(sql, ...params) { return db.prepare(sql).get(...params); }
function exec(sql, ...params)     { if (params.length === 0) return db.exec(sql); return db.prepare(sql).run(...params); }

module.exports = { db, stmts, recomputeStats, markEmailsDeleted, query, queryOne, exec };
