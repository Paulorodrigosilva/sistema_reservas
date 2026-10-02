-- Tabela de Usuários
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  senha TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'usuario',
  pode_editar INTEGER NOT NULL DEFAULT 0
);

-- Tabela de Recursos (Salas, Carros, Caminhões)
CREATE TABLE IF NOT EXISTS recursos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL,
  numero TEXT NOT NULL DEFAULT ''
);

-- Tabela de Reservas
CREATE TABLE IF NOT EXISTS reservas (
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
);

-- Criando índices para melhor performance
CREATE INDEX IF NOT EXISTS idx_reservas_usuario ON reservas(usuario_id);
CREATE INDEX IF NOT EXISTS idx_reservas_recurso ON reservas(recurso_id);
CREATE INDEX IF NOT EXISTS idx_reservas_data ON reservas(data_inicio, data_fim);
