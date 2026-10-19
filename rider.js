const riderForm = document.querySelector('#rider-form');
const riderLoginForm = document.querySelector('#rider-login-form');
const riderPending = document.querySelector('#rider-pending');
const riderDashboard = document.querySelector('#rider-dashboard');
const riderDeclined = document.querySelector('#rider-declined');
const riderAuthSwitch = document.querySelector('.rider-auth-switch');
let activeRider = null;
const handoffFormState = new Map();

function setRiderAuthView(view) {
  riderForm.hidden = view !== 'apply';
  riderLoginForm.hidden = view !== 'login';
  document.querySelectorAll('[data-rider-auth-view]').forEach(button => {
    const selected = button.dataset.riderAuthView === view;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  api.setStatus(document.querySelector('#rider-status'), '');
  api.setStatus(document.querySelector('#rider-login-status'), '');
}

function setRiderView(view) {
  document.querySelectorAll('[data-rider-view]').forEach(button => {
    const selected = button.dataset.riderView === view;
    button.classList.toggle('is-active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-rider-view-panel]').forEach(panel => {
    panel.hidden = panel.dataset.riderViewPanel !== view;
  });
}

function showRiderForms() {
  activeRider = null;
  riderAuthSwitch.hidden = false;
  riderForm.hidden = false;
  riderLoginForm.hidden = true;
  riderPending.hidden = true;
  riderDashboard.hidden = true;
  riderDeclined.hidden = true;
  document.body.classList.remove('rider-dashboard-active');
}

async function renderRiderMessages() {
  const messages = (await api.request('/api/rider/notifications')).notifications;
  const list = document.querySelector('#rider-notification-list');
  list.classList.remove('feedback-message');
  delete list.dataset.state;
  list.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No rider messages yet.';
    list.append(empty);
    return;
  }
  messages.forEach(message => {
    const item = document.createElement('article');
    item.className = 'rider-message';
    const subject = document.createElement('strong');
    subject.textContent = message.subject;
    const body = document.createElement('p');
    body.textContent = message.message;
    const date = document.createElement('time');
    date.dateTime = new Date(message.created_at).toISOString();
    date.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(message.created_at));
    item.append(subject, body, date);
    list.append(item);
  });
}

function renderDeliveries(orders, warning = '') {
  const list = document.querySelector('#assigned-deliveries');
  list.classList.remove('feedback-message');
  delete list.dataset.state;
  list.replaceChildren();
  if (warning) {
    const notice = document.createElement('p');
    notice.className = 'status-message';
    notice.setAttribute('role', 'status');
    api.setStatus(notice, warning);
    list.append(notice);
  }
  if (!orders.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No deliveries have been assigned yet. A&M will update this space when work is available.';
    list.append(empty);
    return;
  }
  orders.forEach(order => {
    const item = document.createElement('article');
    item.className = 'rider-delivery';
    const photo = document.createElement('img');
    photo.className = 'rider-delivery-photo';
    photo.crossOrigin = 'use-credentials';
    photo.src = api.url(`/api/orders/${encodeURIComponent(order.id)}/photo`);
    photo.alt = `Package photo for delivery ${order.reference}`;
    const heading = document.createElement('h3');
    heading.textContent = `${order.reference} · ${order.quantity} × ${order.item}`;
    const status = document.createElement('p');
    status.textContent = `Status: ${order.status}`;
    const pickup = document.createElement('p');
    pickup.textContent = `Pickup: ${order.pickup}`;
    const delivery = document.createElement('p');
    delivery.textContent = `Delivery: ${order.delivery} · ${order.deliveryEmail || 'No contact email'}`;
    const pickupEmail = document.createElement('p');
    pickupEmail.textContent = `Pickup contact: ${order.pickupEmail || 'No contact email'}`;
    const date = document.createElement('p');
    date.textContent = `Pickup date: ${order.date}`;
    item.append(photo, heading, status, pickup, pickupEmail, delivery, date);
    if (order.status === 'Confirmed' && !order.pickupVerified) {
      addHandoffControls(item, order, 'pickup');
    } else if (order.pickupVerified && !order.deliveryVerified
      && ['Collected', 'In transit'].includes(order.status)) {
      addHandoffControls(item, order, 'delivery');
    } else if (order.deliveryVerified) {
      const completed = document.createElement('p');
      completed.textContent = 'Pickup and delivery contacts have both verified the handoff.';
      item.append(completed);
    } else if (order.pickupVerified) {
      const collected = document.createElement('p');
      collected.textContent = 'Pickup verified. Waiting for the delivery to be ready for dispatch.';
      item.append(collected);
    }
    list.append(item);
  });
}

function addHandoffControls(container, order, phase) {
  const label = phase === 'pickup' ? 'pickup' : 'delivery';
  const stateKey = `${order.id}:${phase}`;
  const state = handoffFormState.get(stateKey) || { open: false, code: '', message: '' };
  const message = document.createElement('p');
  message.className = 'handoff-message';
  const sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.className = 'submit-button';
  sendButton.textContent = `Email ${label} code`;
  sendButton.hidden = state.open;
  const form = document.createElement('form');
  form.className = 'handoff-form';
  form.hidden = !state.open;
  const fieldLabel = document.createElement('label');
  fieldLabel.textContent = `Code from the ${label} contact`;
  const codeInput = document.createElement('input');
  codeInput.name = 'code';
  codeInput.type = 'text';
  codeInput.inputMode = 'numeric';
  codeInput.autocomplete = 'one-time-code';
  codeInput.pattern = '[0-9]{6}';
  codeInput.maxLength = 6;
  codeInput.required = true;
  codeInput.placeholder = '6-digit code';
  codeInput.value = state.code;
  codeInput.addEventListener('input', () => {
    state.code = codeInput.value;
    handoffFormState.set(stateKey, state);
  });
  fieldLabel.append(codeInput);
  const verifyButton = document.createElement('button');
  verifyButton.type = 'submit';
  verifyButton.className = 'submit-button';
  verifyButton.textContent = `Verify ${label} code`;
  form.append(fieldLabel, verifyButton);
  if (state.message) api.setStatus(message, state.message, state.messageState || 'success');

  sendButton.addEventListener('click', async () => {
    sendButton.disabled = true;
    message.textContent = '';
    try {
      const result = await api.request(`/api/rider/orders/${encodeURIComponent(order.id)}/handoff-code`, {
        method: 'POST',
        body: JSON.stringify({ phase }),
      });
      state.open = true;
      state.message = result.warning ? `${result.message} ${result.warning}` : result.message;
      state.messageState = result.warning ? 'error' : 'success';
      handoffFormState.set(stateKey, state);
      api.setStatus(message, state.message, state.messageState);
      sendButton.hidden = true;
      form.hidden = false;
      codeInput.focus();
    } catch (error) {
      state.message = error.message;
      state.messageState = 'error';
      handoffFormState.set(stateKey, state);
      api.setStatus(message, error.message);
    } finally {
      sendButton.disabled = false;
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    verifyButton.disabled = true;
    message.textContent = '';
    try {
      const verification = await api.request(`/api/rider/orders/${encodeURIComponent(order.id)}/verify-code`, {
        method: 'POST',
        body: JSON.stringify({ phase, code: codeInput.value }),
      });
      handoffFormState.delete(stateKey);
      const result = await api.request('/api/rider/deliveries');
      renderDeliveries(result.orders, verification.warning || '');
    } catch (error) {
      state.open = true;
      state.code = codeInput.value;
      state.message = error.message;
      state.messageState = 'error';
      handoffFormState.set(stateKey, state);
      api.setStatus(message, error.message);
      verifyButton.disabled = false;
    }
  });
  container.append(sendButton, form, message);
}

async function showRider(rider) {
  activeRider = rider;
  riderAuthSwitch.hidden = true;
  riderForm.hidden = true;
  riderLoginForm.hidden = true;
  riderPending.hidden = rider.status !== 'Pending review';
  riderDashboard.hidden = rider.status !== 'Approved';
  riderDeclined.hidden = rider.status !== 'Declined';
  document.body.classList.toggle('rider-dashboard-active', rider.status === 'Approved');

  if (rider.status === 'Pending review') {
    document.querySelector('#rider-first-name').textContent = rider.name.split(' ')[0];
    document.querySelector('#rider-reference').textContent = `Application ${rider.reference} · Pending review`;
    return;
  }
  if (rider.status === 'Approved') {
    document.querySelector('#dashboard-rider-name').textContent = rider.name.split(' ')[0];
    document.querySelector('#dashboard-rider-area').textContent = rider.area;
    document.querySelector('#dashboard-rider-vehicle').textContent = rider.vehicle;
    const [deliveriesResult, messagesResult] = await Promise.allSettled([
      api.request('/api/rider/deliveries'),
      renderRiderMessages(),
    ]);
    if (deliveriesResult.status === 'fulfilled') renderDeliveries(deliveriesResult.value.orders);
    else api.setStatus(document.querySelector('#assigned-deliveries'), 'Could not load your assigned deliveries. Please refresh.');
    if (messagesResult.status === 'rejected') {
      api.setStatus(document.querySelector('#rider-notification-list'), 'Could not load rider messages. Please refresh.');
    }
    return;
  }
  document.querySelector('#declined-rider-name').textContent = rider.name.split(' ')[0];
  document.querySelector('#declined-rider-reference').textContent = `Application ${rider.reference} · Declined`;
}

async function refreshRiderStatus() {
  try {
    const result = await api.request('/api/rider/me');
    if (result.rider) await showRider(result.rider);
    else showRiderForms();
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      showRiderForms();
      return;
    }
    api.setStatus(document.querySelector('#rider-review-status'), error.message);
  }
}

document.querySelectorAll('[data-rider-auth-view]').forEach(button => {
  button.addEventListener('click', () => setRiderAuthView(button.dataset.riderAuthView));
});

document.querySelectorAll('[data-rider-view]').forEach(button => {
  button.addEventListener('click', () => setRiderView(button.dataset.riderView));
});

riderForm.addEventListener('submit', async event => {
  event.preventDefault();
  const values = new FormData(riderForm);
  const status = document.querySelector('#rider-status');
  if (values.get('password') !== values.get('confirmPassword')) {
    api.setStatus(status, 'Those passwords do not match. Please check and try again.');
    return;
  }
  const submit = riderForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api.request('/api/rider/applications', {
      method: 'POST',
      body: JSON.stringify({
        name: values.get('name'),
        phone: values.get('phone'),
        email: values.get('email'),
        vehicle: values.get('vehicle'),
        license: values.get('license'),
        area: values.get('area'),
        password: values.get('password'),
      }),
    });
    riderForm.reset();
    await showRider(result.rider);
    if (result.warning) {
      api.setStatus(document.querySelector('#rider-application-warning'), result.warning, 'info');
    }
  } catch (error) {
    api.setStatus(status, error.message);
  } finally {
    submit.disabled = false;
  }
});

riderLoginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const values = new FormData(riderLoginForm);
  const status = document.querySelector('#rider-login-status');
  const submit = riderLoginForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api.request('/api/rider/login', {
      method: 'POST',
      body: JSON.stringify({ email: values.get('email'), password: values.get('password') }),
    });
    riderLoginForm.reset();
    await showRider(result.rider);
  } catch (error) {
    api.setStatus(status, error.message);
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('#rider-refresh').addEventListener('click', refreshRiderStatus);
document.querySelector('#check-rider-status').addEventListener('click', refreshRiderStatus);
window.addEventListener('focus', () => {
  if (activeRider) refreshRiderStatus();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && activeRider) refreshRiderStatus();
});
document.querySelector('#rider-sign-out').addEventListener('click', async () => {
  try {
    await api.request('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ role: 'rider' }),
    });
    showRiderForms();
    setRiderAuthView('login');
  } catch (error) {
    api.setStatus(document.querySelector('#rider-review-status'), error.message);
  }
});

setRiderView('overview');
refreshRiderStatus();
