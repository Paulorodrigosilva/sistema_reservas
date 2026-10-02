const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');

const isVercel = Boolean(process.env.VERCEL);
const rawDbUrl = (process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL || process.env.POSTGRES_PRISMA_URL || '').trim();
const isPostgres = Boolean(rawDbUrl) && /^(postgres|postgresql):\/\//i.test(rawDbUrl);

const DEFAULT_MASTER_EMAIL = (process.env.MASTER_EMAIL || 'prodrigosilvacel@gmail.com').trim().toLowerCase();
const DEFAULT_MASTER_PASSWORD = (process.env.MASTER_PASSWORD || 'w18187').trim();

let pgPool = null;
let sqliteDb = null;
let sqlitePath = null;
let initPromise = null;

function getDatabaseType() {
  return isPostgres ? 'postgres' : 'sqlite';
}

function getDatabaseTarget() {
  if (isPostgres) return 'PostgreSQL (Cloud / Supabase / Neon / Vercel Postgres)';
  return isVercel ? 'SQLite (em memória na Vercel - configure DATABASE_URL ou NEON_DATABASE_URL)' : 'SQLite (local database.sqlite)';
}

function initPostgres() {
  if (!pgPool) {
    const isLocalhost = rawDbUrl.includes('localhost') || rawDbUrl.includes('127.0.0.1');
    pgPool = new Pool({
      connectionString: rawDbUrl,
      ssl: isLocalhost ? false : { rejectUnauthorized: false }
    });
  }
  return pgPool;
}

async function initSqlite() {
  if (!sqliteDb) {
    const SQL = await initSqlJs();

    if (isVercel) {
      sqliteDb = new SQL.Database();
      sqlitePath = null;
      if (!isPostgres) {
        console.warn('Nenhuma URL de banco PostgreSQL foi detectada. A app esta usando SQLite em memoria na Vercel, que nao persiste entre invocações. Configure DATABASE_URL ou NEON_DATABASE_URL no ambiente.');
      }
    } else {
      const defaultPath = path.join(__dirname, 'database.sqlite');
      sqlitePath = (process.env.DATABASE_PATH || '').trim() || defaultPath;

      if (fs.existsSync(sqlitePath)) {
        try {
          const fileBuffer = fs.readFileSync(sqlitePath);
          sqliteDb = new SQL.Database(fileBuffer);
        } catch (err) {
          console.warn('Erro ao ler banco existente, iniciando novo:', err.message);
          sqliteDb = new SQL.Database();
        }
      } else {
        sqliteDb = new SQL.Database();
      }
    }
  }
  return sqliteDb;
}

function persistSqlite() {
  if (!sqliteDb || !sqlitePath || isVercel) return;
  try {
    const data = sqliteDb.export();
    const dir = path.dirname(sqlitePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sqlitePath, Buffer.from(data));
  } catch (err) {
    console.error('Falha ao persistir SQLite no disco:', err);
  }
}

function toPgSql(sql) {
  let index = 1;
  let converted = sql.replace(/\?/g, () => `$${index++}`);
  converted = converted.replace(/datetime\(([^)]+)\)/gi, '($1)::timestamp');
  return converted;
}

async function run(sql, params = []) {
  if (isPostgres) {
    const pool = initPostgres();
    let pgSql = toPgSql(sql);
    const isInsert = pgSql.trim().toUpperCase().startsWith('INSERT');
    if (isInsert && !pgSql.toUpperCase().includes('RETURNING')) {
      pgSql += ' RETURNING id';
    }
    const result = await pool.query(pgSql, params);
    const id = result.rows[0]?.id ? Number(result.rows[0].id) : 0;
    return { id, changes: Number(result.rowCount || 0) };
  }

  const db = await initSqlite();
  db.run(sql, params);
  const idRes = db.exec('SELECT last_insert_rowid() AS id');
  const changesRes = db.exec('SELECT changes() AS c');
  const id = Number(idRes[0]?.values[0]?.[0] || 0);
  const changes = Number(changesRes[0]?.values[0]?.[0] || 0);
  persistSqlite();
  return { id, changes };
}

async function get(sql, params = []) {
  if (isPostgres) {
    const pool = initPostgres();
    const result = await pool.query(toPgSql(sql), params);
    return result.rows[0] || null;
  }

  const db = await initSqlite();
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    if (stmt.step()) {
      return stmt.getAsObject();
    }
    return null;
  } finally {
    stmt.free();
  }
}

async function all(sql, params = []) {
  if (isPostgres) {
    const pool = initPostgres();
    const result = await pool.query(toPgSql(sql), params);
    return result.rows || [];
  }

  const db = await initSqlite();
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

function isConstraintError(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || '').toLowerCase();
  return code.startsWith('SQLITE_CONSTRAINT') || code === '23505' || msg.includes('unique constraint') || msg.includes('duplicate key');
}

async function initializeDatabase() {
  if (isPostgres) {
    await run(`CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      senha TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'usuario',
      pode_editar INTEGER NOT NULL DEFAULT 0
    )`);

    await run(`CREATE TABLE IF NOT EXISTS recursos (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      tipo TEXT NOT NULL,
      numero TEXT NOT NULL DEFAULT ''
    )`);

    await run(`CREATE TABLE IF NOT EXISTS reservas (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      recurso_id INTEGER NOT NULL REFERENCES recursos(id) ON DELETE RESTRICT,
      motorista TEXT NOT NULL DEFAULT '',
      destino TEXT NOT NULL DEFAULT '',
      motivo TEXT NOT NULL DEFAULT '',
      km_inicio REAL,
      km_final REAL,
      combustivel_inicio INTEGER,
      combustivel_final INTEGER,
      data_inicio TEXT NOT NULL,
      data_fim TEXT NOT NULL
    )`);

    await run('CREATE INDEX IF NOT EXISTS idx_reservas_usuario ON reservas(usuario_id)');
    await run('CREATE INDEX IF NOT EXISTS idx_reservas_recurso ON reservas(recurso_id)');
    await run('CREATE INDEX IF NOT EXISTS idx_reservas_data ON reservas(data_inicio, data_fim)');
  } else {
    await initSqlite();

    await run(`CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      senha TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'usuario',
      pode_editar INTEGER NOT NULL DEFAULT 0
    )`);

    await run(`CREATE TABLE IF NOT EXISTS recursos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      tipo TEXT NOT NULL,
      numero TEXT NOT NULL DEFAULT ''
    )`);

    await run(`CREATE TABLE IF NOT EXISTS reservas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      recurso_id INTEGER NOT NULL REFERENCES recursos(id),
      motorista TEXT NOT NULL DEFAULT '',
      destino TEXT NOT NULL DEFAULT '',
      motivo TEXT NOT NULL DEFAULT '',
      km_inicio REAL,
      km_final REAL,
      combustivel_inicio INTEGER,
      combustivel_final INTEGER,
      data_inicio TEXT NOT NULL,
      data_fim TEXT NOT NULL
    )`);

    await run('CREATE INDEX IF NOT EXISTS idx_reservas_usuario ON reservas(usuario_id)');
    await run('CREATE INDEX IF NOT EXISTS idx_reservas_recurso ON reservas(recurso_id)');
    await run('CREATE INDEX IF NOT EXISTS idx_reservas_data ON reservas(data_inicio, data_fim)');

    if (!isVercel) {
      const resourceColumns = await all('PRAGMA table_info(recursos)');
      if (!resourceColumns.some((col) => col.name === 'numero')) {
        await run("ALTER TABLE recursos ADD COLUMN numero TEXT NOT NULL DEFAULT ''");
      }
      const userColumns = await all('PRAGMA table_info(usuarios)');
      if (!userColumns.some((col) => col.name === 'pode_editar')) {
        await run('ALTER TABLE usuarios ADD COLUMN pode_editar INTEGER NOT NULL DEFAULT 0');
      }
      const reservationColumns = await all('PRAGMA table_info(reservas)');
      const reservationMigrations = [
        ['motivo', "ALTER TABLE reservas ADD COLUMN motivo TEXT NOT NULL DEFAULT ''"],
        ['km_inicio', 'ALTER TABLE reservas ADD COLUMN km_inicio REAL'],
        ['km_final', 'ALTER TABLE reservas ADD COLUMN km_final REAL'],
        ['combustivel_inicio', 'ALTER TABLE reservas ADD COLUMN combustivel_inicio INTEGER'],
        ['combustivel_final', 'ALTER TABLE reservas ADD COLUMN combustivel_final INTEGER']
      ];
      for (const [column, migration] of reservationMigrations) {
        if (!reservationColumns.some((item) => item.name === column)) await run(migration);
      }
    }
  }

  try {
    const existingMaster = await get('SELECT id FROM usuarios WHERE email = ?', [DEFAULT_MASTER_EMAIL]);
    if (!existingMaster) {
      await run('INSERT INTO usuarios (nome, email, senha, tipo) VALUES (?, ?, ?, ?)', [
        'Administrador Master',
        DEFAULT_MASTER_EMAIL,
        await bcrypt.hash(DEFAULT_MASTER_PASSWORD, 10),
        'master'
      ]);
      console.log(`Usuário master criado: ${DEFAULT_MASTER_EMAIL}`);
    }
  } catch (error) {
    if (!isConstraintError(error)) {
      console.error('Erro ao criar usuário master:', error);
      throw error;
    }
  }
}

function ensureDatabaseReady() {
  if (!initPromise) {
    initPromise = initializeDatabase().catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

module.exports = {
  run,
  get,
  all,
  ensureDatabaseReady,
  isConstraintError,
  getDatabaseType,
  getDatabaseTarget
};
