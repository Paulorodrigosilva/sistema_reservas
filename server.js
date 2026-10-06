const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const {
  run,
  get,const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const {
  run,
  get,
  all,
  ensureDatabaseReady,
  isConstraintError,
  getDatabaseType,
  getDatabaseTarget
} = require('./db');

const app = express();
const port = process.env.VERCEL ? (Number(process.env.PORT) || 3000) : 3000;
const sessionMaxAge = 8 * 60 * 60 * 1000;
const isVercel = Boolean(process.env.VERCEL);
const sessionSecret = (process.env.SESSION_SECRET || '').trim() || 'chave-local-de-desenvolvimento-altere-em-producao';

app.use(express.json({ limit: '32kb' }));
app.set('trust proxy', 1);
app.use((req, res, next) => {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return cookieSession({
    name: 'reserva_session',
    keys: [sessionSecret],
    httpOnly: true,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    maxAge: sessionMaxAge
  })(req, res, next);
});
app.use((req, res, next) => {
  const issuedAt = req.session?.issuedAt;
  if (req.session && (!Number.isFinite(issuedAt) || issuedAt > Date.now() || Date.now() - issuedAt > sessionMaxAge)) {
    req.session = null;
  }
  next();
});

app.get('/api/health', async (req, res) => {
  try {
    await ensureDatabaseReady();
    res.json({
      ok: true,
      ambiente: isVercel ? 'vercel' : 'node',
      tipo_banco: getDatabaseType(),
      origem_banco: getDatabaseTarget()
    });
  } catch (error) {
    console.error('Falha no healthcheck do banco:', error);
    res.status(500).json({ ok: false, mensagem: 'Falha na conexao com o banco de dados.' });
  }
});

app.use((req, res, next) => {
  ensureDatabaseReady().then(() => next()).catch((error) => {
    console.error('Erro ao preparar banco:', error);
    handleError(res, error);
  });
});

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ mensagem: 'Entre na sua conta para continuar.' });
  next();
}

function requireMaster(req, res, next) {
  if (req.session?.user?.tipo !== 'master') {
    return res.status(403).json({ mensagem: 'Apenas o usuario master pode fazer isso.' });
  }
  next();
}

function requireReservationEditor(req, res, next) {
  if (req.session?.user?.tipo !== 'master' && req.session?.user?.pode_editar !== 1) {
    return res.status(403).json({ mensagem: 'Sua conta nao tem permissao para editar reservas.' });
  }
  next();
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function validFuelLevel(value) {
  return value === null || (Number.isInteger(value) && value >= 0 && value <= 100);
}

async function getPreviousOdometer(resourceId, startsAt, excludeId) {
  const excludedReservation = excludeId ? ' AND id != ?' : '';
  const params = [resourceId, startsAt];
  if (excludeId) params.push(excludeId);
  return get(`SELECT km_final FROM reservas WHERE recurso_id = ? AND km_final IS NOT NULL
    AND datetime(data_fim) <= datetime(?)${excludedReservation}
    ORDER BY datetime(data_fim) DESC, id DESC LIMIT 1`, params);
}

async function updateFollowingOdometers(resourceId) {
  const rows = await all(`SELECT id, km_inicio, km_final FROM reservas WHERE recurso_id = ?
    ORDER BY datetime(data_inicio), id`, [resourceId]);
  let latestKm = null;
  for (const row of rows) {
    if (latestKm !== null) {
      await run('UPDATE reservas SET km_inicio = ? WHERE id = ?', [latestKm, row.id]);
    } else if (row.km_inicio !== null && row.km_inicio !== undefined) {
      latestKm = Number(row.km_inicio);
    }
    if (row.km_final !== null && row.km_final !== undefined) latestKm = Number(row.km_final);
  }
}

function handleError(res, error) {
  console.error('Erro na API:', error);
  res.status(500).json({ mensagem: 'Ocorreu um erro interno. Tente novamente.' });
}

app.post('/api/cadastro', async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');
  if (!nome || !email || senha.length < 6) {
    return res.status(400).json({ mensagem: 'Informe nome, e-mail e senha com pelo menos 6 caracteres.' });
  }
  try {
    const result = await run('INSERT INTO usuarios (nome, email, senha, tipo) VALUES (?, ?, ?, ?)', [
      nome, email, await bcrypt.hash(senha, 10), 'usuario'
    ]);
    res.status(201).json({ id: result.id, mensagem: 'Cadastro criado. Agora voce ja pode entrar.' });
  } catch (error) {
    if (isConstraintError(error)) return res.status(409).json({ mensagem: 'Este e-mail ja esta cadastrado.' });
    handleError(res, error);
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const senha = String(req.body.senha || '');

    if (!email || !senha) {
      return res.status(400).json({ mensagem: 'Informe e-mail e senha.' });
    }

    const user = await get('SELECT * FROM usuarios WHERE email = ?', [email]);
    if (!user) return res.status(401).json({ mensagem: 'E-mail ou senha incorretos.' });

    const storedPassword = typeof user.senha === 'string' ? user.senha : '';
    const passwordIsHashed = storedPassword.startsWith('$2');
    const passwordMatches = passwordIsHashed ? await bcrypt.compare(senha, storedPassword) : senha === storedPassword;
    if (!passwordMatches) return res.status(401).json({ mensagem: 'E-mail ou senha incorretos.' });

    if (!passwordIsHashed) {
      await run('UPDATE usuarios SET senha = ? WHERE id = ?', [await bcrypt.hash(senha, 10), user.id]);
    }

    req.session = {
      issuedAt: Date.now(),
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        tipo: user.tipo,
        pode_editar: Number(user.pode_editar || 0)
      }
    };
    res.json({ usuario: req.session.user });
  } catch (error) {
    console.error('Erro no login:', error);
    handleError(res, error);
  }
});

app.get('/api/sessao', (req, res) => res.json({ usuario: req.session?.user || null }));
app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ mensagem: 'Sessao encerrada.' });
});

app.get('/api/usuarios', requireAuth, requireMaster, async (req, res) => {
  try {
    res.json(await all('SELECT id, nome, email, tipo, pode_editar FROM usuarios ORDER BY nome'));
  } catch (error) { handleError(res, error); }
});

app.post('/api/usuarios', requireAuth, requireMaster, async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');
  const podeEditar = req.body.pode_editar === true || req.body.pode_editar === '1' ? 1 : 0;
  if (!nome || !email || senha.length < 6) {
    return res.status(400).json({ mensagem: 'Informe nome, e-mail e senha com pelo menos 6 caracteres.' });
  }
  try {
    const result = await run('INSERT INTO usuarios (nome, email, senha, tipo, pode_editar) VALUES (?, ?, ?, ?, ?)', [
      nome, email, await bcrypt.hash(senha, 10), 'usuario', podeEditar
    ]);
    res.status(201).json({ id: result.id, mensagem: 'Usuario adicionado.' });
  } catch (error) {
    if (isConstraintError(error)) return res.status(409).json({ mensagem: 'Este e-mail ja esta cadastrado.' });
    handleError(res, error);
  }
});

app.patch('/api/usuarios/:id/permissao', requireAuth, requireMaster, async (req, res) => {
  const podeEditar = req.body.pode_editar === true || req.body.pode_editar === 1 || req.body.pode_editar === '1' ? 1 : 0;
  try {
    const result = await run('UPDATE usuarios SET pode_editar = ? WHERE id = ? AND tipo != ?', [
      podeEditar, req.params.id, 'master'
    ]);
    if (!result.changes) return res.status(404).json({ mensagem: 'Usuario comum nao encontrado.' });
    res.json({ mensagem: podeEditar ? 'Permissao para editar ativada.' : 'Permissao para editar removida.' });
  } catch (error) { handleError(res, error); }
});

app.delete('/api/usuarios/:id', requireAuth, requireMaster, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.user.id) return res.status(400).json({ mensagem: 'A conta master nao pode excluir a si mesma.' });
  try {
    await run('DELETE FROM reservas WHERE usuario_id = ?', [id]);
    const result = await run('DELETE FROM usuarios WHERE id = ? AND tipo != ?', [id, 'master']);
    if (!result.changes) return res.status(404).json({ mensagem: 'Usuario nao encontrado.' });
    res.json({ mensagem: 'Usuario excluido.' });
  } catch (error) { handleError(res, error); }
});

app.get('/api/recursos', requireAuth, async (req, res) => {
  try { res.json(await all('SELECT id, nome, tipo, numero FROM recursos ORDER BY tipo, nome')); }
  catch (error) { handleError(res, error); }
});

app.post('/api/recursos', requireAuth, requireMaster, async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  const tipo = String(req.body.tipo || '').trim();
  const numero = String(req.body.numero || '').trim();
  if (!nome || !['sala', 'carro', 'caminhao'].includes(tipo)) {
    return res.status(400).json({ mensagem: 'Informe um nome e um tipo valido.' });
  }
  try {
    const result = await run('INSERT INTO recursos (nome, tipo, numero) VALUES (?, ?, ?)', [nome, tipo, numero]);
    res.status(201).json({ id: result.id, nome, tipo, numero });
  } catch (error) { handleError(res, error); }
});

app.delete('/api/recursos/:id', requireAuth, requireMaster, async (req, res) => {
  try {
    const reservations = await get('SELECT id FROM reservas WHERE recurso_id = ? LIMIT 1', [req.params.id]);
    if (reservations) return res.status(409).json({ mensagem: 'Este recurso tem reservas; exclua as reservas antes.' });
    const result = await run('DELETE FROM recursos WHERE id = ?', [req.params.id]);
    if (!result.changes) return res.status(404).json({ mensagem: 'Recurso nao encontrado.' });
    res.json({ mensagem: 'Recurso excluido.' });
  } catch (error) { handleError(res, error); }
});

const reservationSelect = `SELECT r.id, r.usuario_id, u.nome AS usuario, x.id AS recurso_id,
  x.nome AS recurso, x.tipo AS tipo_recurso, x.numero, r.motorista, r.destino, r.motivo,
  r.km_inicio, r.km_final, r.combustivel_inicio, r.combustivel_final,
  r.data_inicio AS inicio, r.data_fim AS fim
  FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
  JOIN recursos x ON x.id = r.recurso_id`;

app.get('/api/reservas', requireAuth, async (req, res) => {
  try {
    const canEdit = req.session.user.tipo === 'master' || req.session.user.pode_editar === 1;
    let conditions = [];
    let params = [];

    if (!canEdit) {
      conditions.push('r.usuario_id = ?');
      params.push(req.session.user.id);
    }

    // Tratamento correto do intervalo de datas enviado pelo front-end
    const dataInicio = String(req.query.data_inicio || '').trim();
    const dataFim = String(req.query.data_fim || '').trim();

    if (dataInicio && dataFim) {
      // Filtra cruzando o período selecionado
      conditions.push('date(r.data_inicio) <= ? AND date(r.data_fim) >= ?');
      params.push(dataFim, dataInicio);
    } else if (dataInicio) {
      conditions.push('date(r.data_fim) >= ?');
      params.push(dataInicio);
    } else if (dataFim) {
      conditions.push('date(r.data_inicio) <= ?');
      params.push(dataFim);
    } else {
      // Se nenhum filtro de data for passado, traz a partir de hoje
      const hoje = new Date().toISOString().split('T')[0];
      conditions.push('date(r.data_fim) >= ?');
      params.push(hoje);
    }

    const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
    res.json(await all(`${reservationSelect}${where} ORDER BY r.data_inicio`, params));
  } catch (error) { handleError(res, error); }
});

app.get('/api/recursos/:id/odometro', requireAuth, async (req, res) => {
  try {
    const resource = await get('SELECT id, tipo FROM recursos WHERE id = ?', [req.params.id]);
    if (!resource) return res.status(404).json({ mensagem: 'Recurso nao encontrado.' });
    if (resource.tipo === 'sala') return res.status(400).json({ mensagem: 'Salas nao possuem odometro.' });
    const startsAt = req.query.inicio || new Date().toISOString();
    const previous = await getPreviousOdometer(req.params.id, startsAt);
    res.json({ km_inicio_sugerido: previous?.km_final ?? null });
  } catch (error) { handleError(res, error); }
});

app.post('/api/reservas', requireAuth, async (req, res) => {
  const recursoId = Number(req.body.recurso_id);
  const inicio = String(req.body.inicio || '').trim();
  const fim = String(req.body.fim || '').trim();
  const motorista = String(req.body.motorista || '').trim();
  const destino = String(req.body.destino || '').trim();
  const motivo = String(req.body.motivo || '').trim();
  if (!recursoId || !inicio || !fim || new Date(inicio) >= new Date(fim)) {
    return res.status(400).json({ mensagem: 'Informe o recurso e um periodo valido, com fim depois do inicio.' });
  }
  try {
    const resource = await get('SELECT tipo FROM recursos WHERE id = ?', [recursoId]);
    if (!resource) return res.status(404).json({ mensagem: 'Recurso nao encontrado.' });
    if (resource.tipo !== 'sala' && (!motorista || !destino)) {
      return res.status(400).json({ mensagem: 'Para reservar veiculo, informe motorista e destino.' });
    }
    const conflict = await get(`SELECT id FROM reservas WHERE recurso_id = ?
      AND data_fim > ? AND data_inicio < ? LIMIT 1`, [recursoId, inicio, fim]);
    if (conflict) return res.status(409).json({ mensagem: 'Este recurso ja esta reservado nesse periodo.' });
    const previousOdometer = resource.tipo === 'sala' ? null : await getPreviousOdometer(recursoId, inicio);
    const kmInicio = previousOdometer?.km_final ?? null;
    const result = await run(`INSERT INTO reservas
      (usuario_id, recurso_id, motorista, destino, motivo, km_inicio, km_final,
       combustivel_final, data_inicio, data_fim)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      req.session.user.id, recursoId, motorista, destino, motivo, kmInicio, null,
      null, inicio, fim
    ]);
    res.status(201).json({ id: result.id, mensagem: 'Reserva realizada.' });
  } catch (error) { handleError(res, error); }
});

app.put('/api/reservas/:id', requireAuth, requireReservationEditor, async (req, res) => {
  const recursoId = Number(req.body.recurso_id);
  const inicio = String(req.body.inicio || '').trim();
  const fim = String(req.body.fim || '').trim();
  const motorista = String(req.body.motorista || '').trim();
  const destino = String(req.body.destino || '').trim();
  const motivo = String(req.body.motivo || '').trim();
  const kmFinal = parseOptionalNumber(req.body.km_final);
  const combustivelFinal = parseOptionalNumber(req.body.combustivel_final);
  if (!recursoId || !inicio || !fim || new Date(inicio) >= new Date(fim)) {
    return res.status(400).json({ mensagem: 'Informe o recurso e um periodo valido, com fim depois do inicio.' });
  }
  if (Number.isNaN(kmFinal) || (kmFinal !== null && kmFinal < 0) || !validFuelLevel(combustivelFinal) ||
      ((kmFinal === null) !== (combustivelFinal === null))) {
    return res.status(400).json({ mensagem: 'Confira os valores de quilometragem e combustivel.' });
  }
  try {
    const [current, resource] = await Promise.all([
      get('SELECT id, recurso_id FROM reservas WHERE id = ?', [req.params.id]),
      get('SELECT tipo FROM recursos WHERE id = ?', [recursoId])
    ]);
    if (!current) return res.status(404).json({ mensagem: 'Reserva nao encontrada.' });
    if (!resource) return res.status(404).json({ mensagem: 'Recurso nao encontrado.' });
    if (resource.tipo !== 'sala' && (!motorista || !destino)) {
      return res.status(400).json({ mensagem: 'Para veiculos, informe motorista e destino.' });
    }
    const conflict = await get(`SELECT id FROM reservas WHERE recurso_id = ? AND id != ?
      AND data_fim > ? AND data_inicio < ? LIMIT 1`, [recursoId, req.params.id, inicio, fim]);
    if (conflict) return res.status(409).json({ mensagem: 'Este recurso ja esta reservado nesse periodo.' });
    const previousOdometer = resource.tipo === 'sala' ? null : await getPreviousOdometer(recursoId, inicio, req.params.id);
    const kmInicio = previousOdometer?.km_final ?? null;
    if (kmInicio !== null && kmFinal !== null && kmFinal < kmInicio) {
      return res.status(400).json({ mensagem: 'O KM de entrega nao pode ser menor que o KM inicial.' });
    }
    await run(`UPDATE reservas SET recurso_id = ?, motorista = ?, destino = ?, motivo = ?,
      km_inicio = ?, km_final = ?, combustivel_inicio = NULL, combustivel_final = ?,
      data_inicio = ?, data_fim = ? WHERE id = ?`, [
      recursoId, motorista, destino, motivo, kmInicio, kmFinal,
      combustivelFinal, inicio, fim, req.params.id
    ]);
    if (current.recurso_id !== recursoId) await updateFollowingOdometers(current.recurso_id);
    if (resource.tipo !== 'sala') await updateFollowingOdometers(recursoId);
    res.json({ mensagem: 'Reserva atualizada.' });
  } catch (error) { handleError(res, error); }
});

app.delete('/api/reservas/:id', requireAuth, async (req, res) => {
  try {
    const result = req.session.user.tipo === 'master'
      ? await run('DELETE FROM reservas WHERE id = ?', [req.params.id])
      : await run('DELETE FROM reservas WHERE id = ? AND usuario_id = ?', [req.params.id, req.session.user.id]);
    if (!result.changes) return res.status(404).json({ mensagem: 'Reserva nao encontrada.' });
    res.json({ mensagem: 'Reserva cancelada.' });
  } catch (error) { handleError(res, error); }
});

app.use('/api', (req, res) => res.status(404).json({ mensagem: 'Rota da API nao encontrada.' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  ensureDatabaseReady().then(() => {
    app.listen(port, '0.0.0.0', () => console.log(`Sistema de reservas disponivel em http://0.0.0.0:${port}`));
  }).catch((error) => {
    console.error('Falha ao inicializar o banco de dados:', error);
    process.exit(1);
  });
}

module.exports = app;
  all,
  ensureDatabaseReady,
  isConstraintError,
  getDatabaseType,
  getDatabaseTarget
} = require('./db');

const app = express();
const port = process.env.VERCEL ? (Number(process.env.PORT) || 3000) : 3000;
const sessionMaxAge = 8 * 60 * 60 * 1000;
const isVercel = Boolean(process.env.VERCEL);
const sessionSecret = (process.env.SESSION_SECRET || '').trim() || 'chave-local-de-desenvolvimento-altere-em-producao';

app.use(express.json({ limit: '32kb' }));
app.set('trust proxy', 1);
app.use((req, res, next) => {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return cookieSession({
    name: 'reserva_session',
    keys: [sessionSecret],
    httpOnly: true,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    maxAge: sessionMaxAge
  })(req, res, next);
});
app.use((req, res, next) => {
  const issuedAt = req.session?.issuedAt;
  if (req.session && (!Number.isFinite(issuedAt) || issuedAt > Date.now() || Date.now() - issuedAt > sessionMaxAge)) {
    req.session = null;
  }
  next();
});

app.get('/api/health', async (req, res) => {
  try {
    await ensureDatabaseReady();
    res.json({
      ok: true,
      ambiente: isVercel ? 'vercel' : 'node',
      tipo_banco: getDatabaseType(),
      origem_banco: getDatabaseTarget()
    });
  } catch (error) {
    console.error('Falha no healthcheck do banco:', error);
    res.status(500).json({ ok: false, mensagem: 'Falha na conexao com o banco de dados.' });
  }
});

app.use((req, res, next) => {
  ensureDatabaseReady().then(() => next()).catch((error) => {
    console.error('Erro ao preparar banco:', error);
    handleError(res, error);
  });
});

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ mensagem: 'Entre na sua conta para continuar.' });
  next();
}

function requireMaster(req, res, next) {
  if (req.session?.user?.tipo !== 'master') {
    return res.status(403).json({ mensagem: 'Apenas o usuario master pode fazer isso.' });
  }
  next();
}

function requireReservationEditor(req, res, next) {
  if (req.session?.user?.tipo !== 'master' && req.session?.user?.pode_editar !== 1) {
    return res.status(403).json({ mensagem: 'Sua conta nao tem permissao para editar reservas.' });
  }
  next();
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function validFuelLevel(value) {
  return value === null || (Number.isInteger(value) && value >= 0 && value <= 100);
}

async function getPreviousOdometer(resourceId, startsAt, excludeId) {
  const excludedReservation = excludeId ? ' AND id != ?' : '';
  const params = [resourceId, startsAt];
  if (excludeId) params.push(excludeId);
  return get(`SELECT km_final FROM reservas WHERE recurso_id = ? AND km_final IS NOT NULL
    AND datetime(data_fim) <= datetime(?)${excludedReservation}
    ORDER BY datetime(data_fim) DESC, id DESC LIMIT 1`, params);
}

async function updateFollowingOdometers(resourceId) {
  const rows = await all(`SELECT id, km_inicio, km_final FROM reservas WHERE recurso_id = ?
    ORDER BY datetime(data_inicio), id`, [resourceId]);
  let latestKm = null;
  for (const row of rows) {
    if (latestKm !== null) {
      await run('UPDATE reservas SET km_inicio = ? WHERE id = ?', [latestKm, row.id]);
    } else if (row.km_inicio !== null && row.km_inicio !== undefined) {
      latestKm = Number(row.km_inicio);
    }
    if (row.km_final !== null && row.km_final !== undefined) latestKm = Number(row.km_final);
  }
}

function handleError(res, error) {
  console.error('Erro na API:', error);
  res.status(500).json({ mensagem: 'Ocorreu um erro interno. Tente novamente.' });
}

app.post('/api/cadastro', async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');
  if (!nome || !email || senha.length < 6) {
    return res.status(400).json({ mensagem: 'Informe nome, e-mail e senha com pelo menos 6 caracteres.' });
  }
  try {
    const result = await run('INSERT INTO usuarios (nome, email, senha, tipo) VALUES (?, ?, ?, ?)', [
      nome, email, await bcrypt.hash(senha, 10), 'usuario'
    ]);
    res.status(201).json({ id: result.id, mensagem: 'Cadastro criado. Agora voce ja pode entrar.' });
  } catch (error) {
    if (isConstraintError(error)) return res.status(409).json({ mensagem: 'Este e-mail ja esta cadastrado.' });
    handleError(res, error);
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const senha = String(req.body.senha || '');

    if (!email || !senha) {
      return res.status(400).json({ mensagem: 'Informe e-mail e senha.' });
    }

    const user = await get('SELECT * FROM usuarios WHERE email = ?', [email]);
    if (!user) return res.status(401).json({ mensagem: 'E-mail ou senha incorretos.' });

    const storedPassword = typeof user.senha === 'string' ? user.senha : '';
    const passwordIsHashed = storedPassword.startsWith('$2');
    const passwordMatches = passwordIsHashed ? await bcrypt.compare(senha, storedPassword) : senha === storedPassword;
    if (!passwordMatches) return res.status(401).json({ mensagem: 'E-mail ou senha incorretos.' });

    if (!passwordIsHashed) {
      await run('UPDATE usuarios SET senha = ? WHERE id = ?', [await bcrypt.hash(senha, 10), user.id]);
    }

    req.session = {
      issuedAt: Date.now(),
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        tipo: user.tipo,
        pode_editar: Number(user.pode_editar || 0)
      }
    };
    res.json({ usuario: req.session.user });
  } catch (error) {
    console.error('Erro no login:', error);
    handleError(res, error);
  }
});

app.get('/api/sessao', (req, res) => res.json({ usuario: req.session?.user || null }));
app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ mensagem: 'Sessao encerrada.' });
});

app.get('/api/usuarios', requireAuth, requireMaster, async (req, res) => {
  try {
    res.json(await all('SELECT id, nome, email, tipo, pode_editar FROM usuarios ORDER BY nome'));
  } catch (error) { handleError(res, error); }
});

app.post('/api/usuarios', requireAuth, requireMaster, async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');
  const podeEditar = req.body.pode_editar === true || req.body.pode_editar === '1' ? 1 : 0;
  if (!nome || !email || senha.length < 6) {
    return res.status(400).json({ mensagem: 'Informe nome, e-mail e senha com pelo menos 6 caracteres.' });
  }
  try {
    const result = await run('INSERT INTO usuarios (nome, email, senha, tipo, pode_editar) VALUES (?, ?, ?, ?, ?)', [
      nome, email, await bcrypt.hash(senha, 10), 'usuario', podeEditar
    ]);
    res.status(201).json({ id: result.id, mensagem: 'Usuario adicionado.' });
  } catch (error) {
    if (isConstraintError(error)) return res.status(409).json({ mensagem: 'Este e-mail ja esta cadastrado.' });
    handleError(res, error);
  }
});

app.patch('/api/usuarios/:id/permissao', requireAuth, requireMaster, async (req, res) => {
  const podeEditar = req.body.pode_editar === true || req.body.pode_editar === 1 || req.body.pode_editar === '1' ? 1 : 0;
  try {
    const result = await run('UPDATE usuarios SET pode_editar = ? WHERE id = ? AND tipo != ?', [
      podeEditar, req.params.id, 'master'
    ]);
    if (!result.changes) return res.status(404).json({ mensagem: 'Usuario comum nao encontrado.' });
    res.json({ mensagem: podeEditar ? 'Permissao para editar ativada.' : 'Permissao para editar removida.' });
  } catch (error) { handleError(res, error); }
});

app.delete('/api/usuarios/:id', requireAuth, requireMaster, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.user.id) return res.status(400).json({ mensagem: 'A conta master nao pode excluir a si mesma.' });
  try {
    await run('DELETE FROM reservas WHERE usuario_id = ?', [id]);
    const result = await run('DELETE FROM usuarios WHERE id = ? AND tipo != ?', [id, 'master']);
    if (!result.changes) return res.status(404).json({ mensagem: 'Usuario nao encontrado.' });
    res.json({ mensagem: 'Usuario excluido.' });
  } catch (error) { handleError(res, error); }
});

app.get('/api/recursos', requireAuth, async (req, res) => {
  try { res.json(await all('SELECT id, nome, tipo, numero FROM recursos ORDER BY tipo, nome')); }
  catch (error) { handleError(res, error); }
});

app.post('/api/recursos', requireAuth, requireMaster, async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  const tipo = String(req.body.tipo || '').trim();
  const numero = String(req.body.numero || '').trim();
  if (!nome || !['sala', 'carro', 'caminhao'].includes(tipo)) {
    return res.status(400).json({ mensagem: 'Informe um nome e um tipo valido.' });
  }
  try {
    const result = await run('INSERT INTO recursos (nome, tipo, numero) VALUES (?, ?, ?)', [nome, tipo, numero]);
    res.status(201).json({ id: result.id, nome, tipo, numero });
  } catch (error) { handleError(res, error); }
});

app.delete('/api/recursos/:id', requireAuth, requireMaster, async (req, res) => {
  try {
    const reservations = await get('SELECT id FROM reservas WHERE recurso_id = ? LIMIT 1', [req.params.id]);
    if (reservations) return res.status(409).json({ mensagem: 'Este recurso tem reservas; exclua as reservas antes.' });
    const result = await run('DELETE FROM recursos WHERE id = ?', [req.params.id]);
    if (!result.changes) return res.status(404).json({ mensagem: 'Recurso nao encontrado.' });
    res.json({ mensagem: 'Recurso excluido.' });
  } catch (error) { handleError(res, error); }
});

const reservationSelect = `SELECT r.id, r.usuario_id, u.nome AS usuario, x.id AS recurso_id,
  x.nome AS recurso, x.tipo AS tipo_recurso, x.numero, r.motorista, r.destino, r.motivo,
  r.km_inicio, r.km_final, r.combustivel_inicio, r.combustivel_final,
  r.data_inicio AS inicio, r.data_fim AS fim
  FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
  JOIN recursos x ON x.id = r.recurso_id`;

app.get('/api/reservas', requireAuth, async (req, res) => {
  try {
    const canEdit = req.session.user.tipo === 'master' || req.session.user.pode_editar === 1;
    let conditions = [];
    let params = [];

    if (!canEdit) {
      conditions.push('r.usuario_id = ?');
      params.push(req.session.user.id);
    }

    // Se a query enviar uma data específica de filtro
    const dataFiltro = String(req.query.data || '').trim();
    if (dataFiltro) {
      conditions.push('date(r.data_fim) >= ? AND date(r.data_inicio) <= ?');
      params.push(dataFiltro, dataFiltro);
    } else {
      // Se não houver filtro de data informado, oculta as passadas (mostra de hoje em diante)
      const hoje = new Date().toISOString().split('T')[0];
      conditions.push('date(r.data_fim) >= ?');
      params.push(hoje);
    }

    const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
    res.json(await all(`${reservationSelect}${where} ORDER BY r.data_inicio`, params));
  } catch (error) { handleError(res, error); }
});

app.get('/api/recursos/:id/odometro', requireAuth, async (req, res) => {
  try {
    const resource = await get('SELECT id, tipo FROM recursos WHERE id = ?', [req.params.id]);
    if (!resource) return res.status(404).json({ mensagem: 'Recurso nao encontrado.' });
    if (resource.tipo === 'sala') return res.status(400).json({ mensagem: 'Salas nao possuem odometro.' });
    const startsAt = req.query.inicio || new Date().toISOString();
    const previous = await getPreviousOdometer(req.params.id, startsAt);
    res.json({ km_inicio_sugerido: previous?.km_final ?? null });
  } catch (error) { handleError(res, error); }
});

app.post('/api/reservas', requireAuth, async (req, res) => {
  const recursoId = Number(req.body.recurso_id);
  const inicio = String(req.body.inicio || '').trim();
  const fim = String(req.body.fim || '').trim();
  const motorista = String(req.body.motorista || '').trim();
  const destino = String(req.body.destino || '').trim();
  const motivo = String(req.body.motivo || '').trim();
  if (!recursoId || !inicio || !fim || new Date(inicio) >= new Date(fim)) {
    return res.status(400).json({ mensagem: 'Informe o recurso e um periodo valido, com fim depois do inicio.' });
  }
  try {
    const resource = await get('SELECT tipo FROM recursos WHERE id = ?', [recursoId]);
    if (!resource) return res.status(404).json({ mensagem: 'Recurso nao encontrado.' });
    if (resource.tipo !== 'sala' && (!motorista || !destino)) {
      return res.status(400).json({ mensagem: 'Para reservar veiculo, informe motorista e destino.' });
    }
    const conflict = await get(`SELECT id FROM reservas WHERE recurso_id = ?
      AND data_fim > ? AND data_inicio < ? LIMIT 1`, [recursoId, inicio, fim]);
    if (conflict) return res.status(409).json({ mensagem: 'Este recurso ja esta reservado nesse periodo.' });
    const previousOdometer = resource.tipo === 'sala' ? null : await getPreviousOdometer(recursoId, inicio);
    const kmInicio = previousOdometer?.km_final ?? null;
    const result = await run(`INSERT INTO reservas
      (usuario_id, recurso_id, motorista, destino, motivo, km_inicio, km_final,
       combustivel_final, data_inicio, data_fim)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      req.session.user.id, recursoId, motorista, destino, motivo, kmInicio, null,
      null, inicio, fim
    ]);
    res.status(201).json({ id: result.id, mensagem: 'Reserva realizada.' });
  } catch (error) { handleError(res, error); }
});

app.put('/api/reservas/:id', requireAuth, requireReservationEditor, async (req, res) => {
  const recursoId = Number(req.body.recurso_id);
  const inicio = String(req.body.inicio || '').trim();
  const fim = String(req.body.fim || '').trim();
  const motorista = String(req.body.motorista || '').trim();
  const destino = String(req.body.destino || '').trim();
  const motivo = String(req.body.motivo || '').trim();
  const kmFinal = parseOptionalNumber(req.body.km_final);
  const combustivelFinal = parseOptionalNumber(req.body.combustivel_final);
  if (!recursoId || !inicio || !fim || new Date(inicio) >= new Date(fim)) {
    return res.status(400).json({ mensagem: 'Informe o recurso e um periodo valido, com fim depois do inicio.' });
  }
  if (Number.isNaN(kmFinal) || (kmFinal !== null && kmFinal < 0) || !validFuelLevel(combustivelFinal) ||
      ((kmFinal === null) !== (combustivelFinal === null))) {
    return res.status(400).json({ mensagem: 'Confira os valores de quilometragem e combustivel.' });
  }
  try {
    const [current, resource] = await Promise.all([
      get('SELECT id, recurso_id FROM reservas WHERE id = ?', [req.params.id]),
      get('SELECT tipo FROM recursos WHERE id = ?', [recursoId])
    ]);
    if (!current) return res.status(404).json({ mensagem: 'Reserva nao encontrada.' });
    if (!resource) return res.status(404).json({ mensagem: 'Recurso nao encontrado.' });
    if (resource.tipo !== 'sala' && (!motorista || !destino)) {
      return res.status(400).json({ mensagem: 'Para veiculos, informe motorista e destino.' });
    }
    const conflict = await get(`SELECT id FROM reservas WHERE recurso_id = ? AND id != ?
      AND data_fim > ? AND data_inicio < ? LIMIT 1`, [recursoId, req.params.id, inicio, fim]);
    if (conflict) return res.status(409).json({ mensagem: 'Este recurso ja esta reservado nesse periodo.' });
    const previousOdometer = resource.tipo === 'sala' ? null : await getPreviousOdometer(recursoId, inicio, req.params.id);
    const kmInicio = previousOdometer?.km_final ?? null;
    if (kmInicio !== null && kmFinal !== null && kmFinal < kmInicio) {
      return res.status(400).json({ mensagem: 'O KM de entrega nao pode ser menor que o KM inicial.' });
    }
    await run(`UPDATE reservas SET recurso_id = ?, motorista = ?, destino = ?, motivo = ?,
      km_inicio = ?, km_final = ?, combustivel_inicio = NULL, combustivel_final = ?,
      data_inicio = ?, data_fim = ? WHERE id = ?`, [
      recursoId, motorista, destino, motivo, kmInicio, kmFinal,
      combustivelFinal, inicio, fim, req.params.id
    ]);
    if (current.recurso_id !== recursoId) await updateFollowingOdometers(current.recurso_id);
    if (resource.tipo !== 'sala') await updateFollowingOdometers(recursoId);
    res.json({ mensagem: 'Reserva atualizada.' });
  } catch (error) { handleError(res, error); }
});

app.delete('/api/reservas/:id', requireAuth, async (req, res) => {
  try {
    const result = req.session.user.tipo === 'master'
      ? await run('DELETE FROM reservas WHERE id = ?', [req.params.id])
      : await run('DELETE FROM reservas WHERE id = ? AND usuario_id = ?', [req.params.id, req.session.user.id]);
    if (!result.changes) return res.status(404).json({ mensagem: 'Reserva nao encontrada.' });
    res.json({ mensagem: 'Reserva cancelada.' });
  } catch (error) { handleError(res, error); }
});

app.use('/api', (req, res) => res.status(404).json({ mensagem: 'Rota da API nao encontrada.' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  ensureDatabaseReady().textn?.() || ensureDatabaseReady().then(() => {
    app.listen(port, '0.0.0.0', () => console.log(`Sistema de reservas disponivel em http://0.0.0.0:${port}`));
  }).catch((error) => {
    console.error('Falha ao inicializar o banco de dados:', error);
    process.exit(1);
  });
}

module.exports = app;
