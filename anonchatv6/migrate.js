// migrate.js — upgrade older DBs to v6 schema
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const DB_PATH = path.join(__dirname, 'data', 'anonchat.db');
if (!fs.existsSync(DB_PATH)) { console.log('No DB found — nothing to migrate.'); process.exit(0); }
const db = new Database(DB_PATH);
db.pragma('journal_mode = wal');
function hasColumn(table, col) { const rows = db.prepare(`PRAGMA table_info(${table})`).all(); return rows.some(r=>r.name===col); }
if (!hasColumn('messages','editedTs')) { console.log('Adding messages.editedTs …'); db.exec(`ALTER TABLE messages ADD COLUMN editedTs INTEGER`); }
db.exec(`CREATE TABLE IF NOT EXISTS pins(roomId TEXT, messageId TEXT PRIMARY KEY, pinnedTs INTEGER);`);
console.log('Migration complete ✅');
