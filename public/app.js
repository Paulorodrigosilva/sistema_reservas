const authScreen = document.querySelector('#auth-screen');
const appScreen = document.querySelector('#app-screen');
const authForm = document.querySelector('#auth-form');
const authMessage = document.querySelector('#auth-message');
const resourceSelect = document.querySelector('#resource-select');
const reservationForm = document.querySelector('#reservation-form');
const reservationMessage = document.querySelector('#reservation-message');
const reservationsList = document.querySelector('#reservation-list');
const emptyState = document.querySelector('#empty-state');
const resourceForm = document.querySelector('#resource-form');
const userForm = document.querySelector('#user-form');
const dateStartFilter = document.querySelector('#date-start-filter'); // Filtro Data Inicial
const dateEndFilter = document.querySelector('#date-end-filter');     // Filtro Data Final

let currentUser = null;
let resources = [];
let reservations = [];
let users = [];
let authMode = 'login';
let editingReservationId = null;
let toastTimer;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = response.status === 204 ? {} : isJson ? await response.json() : {};
  if (!response.ok) throw new Error(payload.mensagem || 'Não foi possível concluir a solicitação.');
  if (!isJson && response.status !== 204) throw new Error('O servidor respondeu fora da API. Atualize a página e tente novamente.');
  return payload;
}

function setMessage(element, text, success = false) {
  element.textContent = text;
  element.classList.toggle('is-success', success);
}

function showToast(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
}

function formatDate(value, options = { day: '2-digit', month: 'short' }) {
  return new Intl.DateTimeFormat('pt-BR', options).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function csvValue(value) {
  const text = value === null || value === undefined ? '' : String(value);
  const safeText = /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
}

function exportReservations() {
  const filter = document.querySelector('#reservation-filter').value;
  const filtered = reservations
    .filter((reservation) => filter === 'todos' || reservation.tipo_recurso === filter)
    .sort((first, second) => new Date(first.inicio) - new Date(second.inicio));
  if (!filtered.length) {
    showToast('Não há reservas para exportar neste filtro.');
    return;
  }

  const columns = [
    ['ID', (reservation) => reservation.id],
    ['Solicitante', (reservation) => reservation.usuario],
    ['Recurso', (reservation) => reservation.recurso],
    ['Tipo', (reservation) => reservation.tipo_recurso],
    ['Número ou placa', (reservation) => reservation.numero],
    ['Início', (reservation) => formatDate(reservation.inicio, { day: '2-digit', month: '2-digit', year: 'numeric' }) + ` ${formatTime(reservation.inicio)}`],
    ['Fim', (reservation) => formatDate(reservation.fim, { day: '2-digit', month: '2-digit', year: 'numeric' }) + ` ${formatTime(reservation.fim)}`],
    ['Motorista', (reservation) => reservation.motorista],
    ['Destino', (reservation) => reservation.destino],
    ['Motivo', (reservation) => reservation.motivo],
    ['KM inicial', (reservation) => reservation.km_inicio],
    ['KM final', (reservation) => reservation.km_final],
    ['Combustível inicial (%)', (reservation) => reservation.combustivel_inicio],
    ['Combustível final (%)', (reservation) => reservation.combustivel_final]
  ];
  const rows = [columns.map(([heading]) => heading), ...filtered.map((reservation) =>
    columns.map(([, value]) => value(reservation))
  )];
  const csv = `\uFEFF${rows.map((row) => row.map(csvValue).join(';')).join('\r\n')}`;
  const downloadUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = `reservas-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(downloadUrl);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function showAuth(mode = 'login') {
  authMode = mode;
  const registering = mode === 'register';
  document.querySelector('#name-field').hidden = !registering;
  document.querySelector('#name-field input').required = registering;
  document.querySelector('#auth-eyebrow').textContent = registering ? 'COMECE POR AQUI' : 'BEM-VINDO DE VOLTA';
  document.querySelector('#auth-title').textContent = registering ? 'Crie sua conta' : 'Acesse sua conta';
  document.querySelector('#auth-description').textContent = registering
    ? 'Seu cadastro libera acesso à agenda de reservas.'
    : 'Entre para consultar a agenda e fazer uma reserva.';
  document.querySelector('#auth-submit').innerHTML = registering
    ? 'Criar conta <span aria-hidden="true">↗</span>'
    : 'Entrar <span aria-hidden="true">↗</span>';
  document.querySelectorAll('[data-auth-mode]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.authMode === mode);
  });
  setMessage(authMessage, '');
}

function renderApp() {
  const isMaster = currentUser.tipo === 'master';
  authScreen.hidden = true;
  appScreen.hidden = false;
  document.querySelector('#account-name').textContent = currentUser.nome;
  document.querySelector('#account-avatar').textContent = currentUser.nome.trim().charAt(0).toUpperCase();
  document.querySelector('#account-role').textContent = isMaster ? 'Master' : 'Usuário';
  document.querySelectorAll('.admin-only').forEach((element) => { element.hidden = !isMaster; });
  document.querySelector('#today-label').textContent = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'short', day: '2-digit', month: 'long'
  }).format(new Date());
}

function renderResources() {
  const selected = resourceSelect.value;
  resourceSelect.innerHTML = '<option value="">Selecione um recurso</option>' + resources.map((resource) => {
    const label = `${resource.nome}${resource.numero ? ` · ${resource.numero}` : ''}`;
    return `<option value="${resource.id}" data-type="${escapeHtml(resource.tipo)}">${escapeHtml(label)} · ${escapeHtml(resource.tipo)}</option>`;
  }).join('');
  if (resources.some((resource) => String(resource.id) === selected)) resourceSelect.value = selected;
  document.querySelector('#stat-resources').textContent = resources.length;
  renderResourceList();
  updateVehicleFields();
}

function updateVehicleFields() {
  const resource = resources.find((item) => String(item.id) === resourceSelect.value);
  const isVehicle = resource && resource.tipo !== 'sala';
  document.querySelector('#vehicle-fields').hidden = !isVehicle;
  reservationForm.elements.motorista.required = Boolean(isVehicle);
  reservationForm.elements.destino.required = Boolean(isVehicle);
}

async function fillSuggestedOdometer() {
  const resource = resources.find((item) => String(item.id) === resourceSelect.value);
  if (!resource || resource.tipo === 'sala' || editingReservationId) return;
  const resourceId = String(resource.id);
  const odometerField = reservationForm.elements.km_inicio;
  odometerField.value = '';
  odometerField.placeholder = 'Buscando último KM...';
  try {
    const startsAt = reservationForm.elements.inicio.value || new Date().toISOString();
    const result = await api(`/api/recursos/${resourceId}/odometro?inicio=${encodeURIComponent(startsAt)}`);
    if (resourceSelect.value !== resourceId || editingReservationId) return;
    odometerField.value = result.km_inicio_sugerido ?? '';
    odometerField.placeholder = result.km_inicio_sugerido === null
      ? 'Primeiro uso: informe o KM' : 'Último KM registrado';
  } catch (error) {
    odometerField.placeholder = 'Informe o KM de saída';
    showToast(error.message);
  }
}

function reservationEditAllowed() {
  return currentUser.tipo === 'master' || Number(currentUser.pode_editar) === 1;
}

function setReservationEditMode(reservation = null) {
  editingReservationId = reservation?.id ?? null;
  const title = document.querySelector('#booking-title');
  const description = document.querySelector('#booking-description');
  const submit = document.querySelector('#reservation-submit');
  const cancel = document.querySelector('#cancel-edit');
  if (!reservation) {
    reservationForm.reset();
    document.querySelectorAll('.completion-field').forEach((field) => { field.hidden = true; });
    title.textContent = 'Nova reserva';
    description.textContent = 'Escolha o recurso e o período.';
    submit.innerHTML = 'Confirmar reserva <span aria-hidden="true">↗</span>';
    cancel.hidden = true;
    updateVehicleFields();
    return;
  }
  reservationForm.reset();
  document.querySelectorAll('.completion-field').forEach((field) => { field.hidden = false; });
  resourceSelect.value = String(reservation.recurso_id);
  reservationForm.elements.inicio.value = toLocalDateTime(reservation.inicio);
  reservationForm.elements.fim.value = toLocalDateTime(reservation.fim);
  reservationForm.elements.motorista.value = reservation.motorista || '';
  reservationForm.elements.destino.value = reservation.destino || '';
  reservationForm.elements.motivo.value = reservation.motivo || '';
  reservationForm.elements.km_inicio.value = reservation.km_inicio ?? '';
  reservationForm.elements.km_final.value = reservation.km_final ?? '';
  reservationForm.elements.combustivel_final.value = reservation.combustivel_final ?? '';
  updateVehicleFields();
  title.textContent = 'Editar reserva';
  description.textContent = 'Atualize os dados e salve as alterações.';
  submit.innerHTML = 'Salvar alterações <span aria-hidden="true">↗</span>';
  cancel.hidden = false;
  document.querySelector('#agenda-view').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toLocalDateTime(value) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function renderReservations() {
  const filter = document.querySelector('#reservation-filter').value;
  const filtered = reservations.filter((reservation) => filter === 'todos' || reservation.tipo_recurso === filter);
  const now = Date.now();
  const upcoming = reservations.filter((reservation) => new Date(reservation.fim).getTime() >= now)
    .sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
  const ownCount = reservations.filter((reservation) => reservation.usuario_id === currentUser.id).length;
  document.querySelector('#stat-mine').textContent = ownCount;
  document.querySelector('#stat-next').textContent = upcoming[0] ? formatDate(upcoming[0].inicio) : '—';
  document.querySelector('#stat-next-detail').textContent = upcoming[0]
    ? `${formatTime(upcoming[0].inicio)} · ${upcoming[0].recurso}` : 'Nenhuma reserva futura';
  reservationsList.innerHTML = filtered.map((reservation) => {
    const start = new Date(reservation.inicio);
    const month = new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(start).replace('.', '');
    const label = reservation.tipo_recurso === 'sala' ? 'Sala' : reservation.tipo_recurso === 'carro' ? 'Carro' : 'Caminhão';
    const details = [
      reservation.numero && `Nº ${reservation.numero}`,
      reservation.motorista && `Motorista: ${reservation.motorista}`,
      reservation.destino && `Destino: ${reservation.destino}`,
      reservation.motivo && `Motivo: ${reservation.motivo}`,
      reservation.km_inicio !== null && reservation.km_inicio !== undefined && `KM saída: ${reservation.km_inicio}`,
      reservation.km_final !== null && reservation.km_final !== undefined && `KM retorno: ${reservation.km_final}`,
      reservation.combustivel_final !== null && reservation.combustivel_final !== undefined && `Combustível retorno: ${reservation.combustivel_final}%`
    ].filter(Boolean).map(escapeHtml).join('<span aria-hidden="true">·</span>');
    const owner = reservationEditAllowed() ? `<span class="reservation-owner">Solicitante: ${escapeHtml(reservation.usuario)}</span>` : '';
    const editAction = reservationEditAllowed()
      ? `<button class="reservation-action" type="button" data-edit-reservation="${reservation.id}" title="Editar reserva">Editar</button>` : '';
    const canCancel = currentUser.tipo === 'master' || reservation.usuario_id === currentUser.id;
    const cancelAction = canCancel
      ? `<button class="cancel-button" type="button" data-cancel-reservation="${reservation.id}" aria-label="Cancelar reserva de ${escapeHtml(reservation.recurso)}" title="Cancelar reserva">×</button>` : '';
    return `<article class="reservation-item">
      <div class="date-tile"><strong>${String(start.getDate()).padStart(2, '0')}</strong><span>${escapeHtml(month)}</span></div>
      <div class="reservation-main"><div class="reservation-title-row"><strong class="reservation-title">${escapeHtml(reservation.recurso)}</strong><span class="type-tag ${escapeHtml(reservation.tipo_recurso)}">${label}</span></div>
        <p class="reservation-time">${formatDate(reservation.inicio, { day: '2-digit', month: 'short', year: 'numeric' })} · ${formatTime(reservation.inicio)}–${formatTime(reservation.fim)}</p>
        ${details ? `<div class="reservation-details">${details}</div>` : ''}${owner}</div>
      <div class="reservation-actions">${editAction}${cancelAction}</div>
    </article>`;
  }).join('');
  emptyState.hidden = filtered.length > 0;
}

function renderResourceList() {
  const list =
