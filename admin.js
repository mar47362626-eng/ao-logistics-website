const statuses = ['Received', 'Confirmed', 'Collected', 'In transit', 'Delivered', 'Cancelled'];
const orderRows = document.querySelector('#order-rows');
const searchInput = document.querySelector('#order-search');
const statusFilter = document.querySelector('#status-filter');
const detailPanel = document.querySelector('#order-detail');
let orders = [];
let users = [];
let riders = [];
let notifications = [];
let registrations = [];
let selectedOrderId = null;

function currentStatus(order) {
  return order.status || 'Received';
}

function formattedDate(value) {
  if (!value) return 'Not set';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

function formattedTimestamp(value) {
  if (!value) return 'Not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not set' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function addCell(row, value, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = value || 'Not provided';
  row.append(cell);
}

function setMetric(selector, value) {
  document.querySelector(selector).textContent = String(value);
}

function renderMetrics() {
  setMetric('#metric-total', orders.length);
  setMetric('#metric-users', users.length);
  setMetric('#metric-riders', riders.length);
  setMetric('#metric-review', orders.filter(order => currentStatus(order) === 'Received').length);
  setMetric('#metric-transit', orders.filter(order => currentStatus(order) === 'In transit').length);
  setMetric('#metric-delivered', orders.filter(order => currentStatus(order) === 'Delivered').length);
  document.querySelector('#sidebar-count').textContent = String(orders.length);
  document.querySelector('#user-count').textContent = String(users.length);
  document.querySelector('#rider-count').textContent = String(riders.length);
}

function filteredOrders() {
  const query = searchInput.value.trim().toLowerCase();
  const status = statusFilter.value;
  return orders.filter(order => {
    const matchesStatus = status === 'all' || currentStatus(order) === status;
    const searchable = [order.reference, order.item, order.email, order.phone, order.pickup, order.delivery].join(' ').toLowerCase();
    return matchesStatus && searchable.includes(query);
  });
}

function statusBadge(status) {
  const badge = document.createElement('span');
  badge.className = 'status-pill';
  badge.dataset.status = status;
  badge.textContent = status;
  return badge;
}

function renderQueue() {
  const visibleOrders = filteredOrders();
  document.querySelector('#queue-summary').textContent = `${visibleOrders.length} of ${orders.length} ${orders.length === 1 ? 'request' : 'requests'}`;
  orderRows.replaceChildren();
  if (!visibleOrders.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'empty-cell';
    cell.colSpan = 4;
    cell.textContent = orders.length ? 'No requests match your search.' : 'No delivery requests yet.';
    row.append(cell);
    orderRows.append(row);
    return;
  }
  visibleOrders.forEach(order => {
    const row = document.createElement('tr');
    row.classList.toggle('is-selected', order.id === selectedOrderId);
    row.addEventListener('click', () => selectOrder(order.id));

    const requestCell = document.createElement('td');
    const requestButton = document.createElement('button');
    requestButton.className = 'request-button';
    requestButton.type = 'button';
    requestButton.setAttribute('aria-label', `Review request ${order.reference}`);
    const reference = document.createElement('span');
    reference.className = 'request-ref';
    reference.textContent = order.reference;
    const item = document.createElement('span');
    item.className = 'request-item';
    item.textContent = `${order.quantity} × ${order.item}`;
    requestButton.append(reference, item);
    requestCell.append(requestButton);

    const customerCell = document.createElement('td');
    const name = document.createElement('span');
    name.className = 'customer-name';
    name.textContent = order.name || order.email;
    const email = document.createElement('span');
    email.className = 'customer-email';
    email.textContent = order.email;
    customerCell.append(name, email);

    const dateCell = document.createElement('td');
    dateCell.className = 'pickup-date';
    dateCell.textContent = formattedDate(order.date);
    const statusCell = document.createElement('td');
    statusCell.append(statusBadge(currentStatus(order)));
    row.append(requestCell, customerCell, dateCell, statusCell);
    orderRows.append(row);
  });
}

function addDetailField(grid, label, value) {
  const field = document.createElement('div');
  field.className = 'detail-field';
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value || 'Not provided';
  field.append(term, description);
  grid.append(field);
}

function addDetailCopy(container, label, value) {
  const section = document.createElement('section');
  section.className = 'detail-copy';
  const heading = document.createElement('h3');
  heading.textContent = label;
  const text = document.createElement('p');
  text.textContent = value || 'No additional details provided.';
  section.append(heading, text);
  container.append(section);
}

function renderDetail(order, message = '', messageState = 'success') {
  detailPanel.replaceChildren();
  const header = document.createElement('div');
  header.className = 'detail-header';
  const titleBlock = document.createElement('div');
  const reference = document.createElement('span');
  reference.className = 'detail-reference';
  reference.textContent = order.reference;
  const title = document.createElement('h2');
  title.className = 'detail-title';
  title.textContent = `${order.quantity} × ${order.item}`;
  titleBlock.append(reference, title);
  header.append(titleBlock, statusBadge(currentStatus(order)));
  detailPanel.append(header);

  const image = document.createElement('img');
  image.className = 'detail-photo';
  image.crossOrigin = 'use-credentials';
  image.src = api.url(`/api/orders/${encodeURIComponent(order.id)}/photo`);
  image.alt = `Customer photo of ${order.item}`;
  detailPanel.append(image);

  const fields = document.createElement('dl');
  fields.className = 'detail-fields';
  addDetailField(fields, 'Customer', order.name);
  addDetailField(fields, 'Email', order.email);
  addDetailField(fields, 'Phone', order.phone);
  addDetailField(fields, 'Pickup date', formattedDate(order.date));
  detailPanel.append(fields);

  const route = document.createElement('div');
  route.className = 'detail-route';
  [[order.pickup, 'Pickup'], [order.delivery, 'Delivery']].forEach(([address, label]) => {
    const stop = document.createElement('div');
    stop.className = 'route-stop';
    const marker = document.createElement('span');
    const text = document.createElement('span');
    text.textContent = `${label}: ${address || 'Address not provided'}`;
    stop.append(marker, text);
    route.append(stop);
  });
  detailPanel.append(route);
  addDetailCopy(detailPanel, 'Handling notes', order.description);
  if (order.notes) addDetailCopy(detailPanel, 'Additional instructions', order.notes);

  const form = document.createElement('form');
  form.className = 'status-editor';
  const statusLabel = document.createElement('label');
  statusLabel.textContent = 'Update request status';
  const statusSelect = document.createElement('select');
  statusSelect.name = 'status';
  statuses.filter(status => {
    if (status === 'Collected' || status === 'Delivered') return status === currentStatus(order);
    if (status === 'In transit' && !order.pickupVerified) return status === currentStatus(order);
    return true;
  }).forEach(status => {
    const option = document.createElement('option');
    option.value = status;
    option.textContent = status;
    statusSelect.append(option);
  });
  statusSelect.value = currentStatus(order);
  statusLabel.append(statusSelect);

  const riderLabel = document.createElement('label');
  riderLabel.textContent = 'Assign an approved rider';
  const riderSelect = document.createElement('select');
  riderSelect.name = 'riderId';
  const unassigned = document.createElement('option');
  unassigned.value = '';
  unassigned.textContent = 'Not assigned';
  riderSelect.append(unassigned);
  riders.filter(rider => rider.status === 'Approved').forEach(rider => {
    const option = document.createElement('option');
    option.value = rider.id;
    option.textContent = `${rider.name} · ${rider.area}`;
    riderSelect.append(option);
  });
  riderSelect.value = order.riderId || '';
  riderLabel.append(riderSelect);

  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.textContent = 'Save changes';
  saveButton.disabled = true;
  const updateButtonState = () => {
    saveButton.disabled = statusSelect.value === currentStatus(order) && riderSelect.value === (order.riderId || '');
  };
  statusSelect.addEventListener('change', updateButtonState);
  riderSelect.addEventListener('change', updateButtonState);
  const statusMessage = document.createElement('p');
  statusMessage.className = 'status-message';
  statusMessage.setAttribute('role', 'status');
  api.setStatus(statusMessage, message, messageState);
  form.append(statusLabel, riderLabel, saveButton, statusMessage);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      const result = await api.request(`/api/admin/orders/${encodeURIComponent(order.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: statusSelect.value, riderId: riderSelect.value }),
      });
      orders = orders.map(savedOrder => savedOrder.id === result.order.id ? result.order : savedOrder);
      renderMetrics();
      renderQueue();
      renderDetail(
        result.order,
        result.warning || 'Order changes saved.',
        result.warning ? 'error' : 'success',
      );
    } catch (error) {
      api.setStatus(statusMessage, error.message);
      saveButton.disabled = false;
      saveButton.textContent = 'Save changes';
    }
  });
  detailPanel.append(form);
}

function selectOrder(orderId) {
  selectedOrderId = orderId;
  renderQueue();
  const order = orders.find(item => item.id === orderId);
  if (order) renderDetail(order);
}

function renderUsers() {
  const query = document.querySelector('#user-search').value.trim().toLowerCase();
  const rows = document.querySelector('#user-rows');
  const visibleUsers = users.filter(user => [user.name, user.email, user.phone].join(' ').toLowerCase().includes(query));
  rows.replaceChildren();
  if (!visibleUsers.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'empty-cell';
    cell.colSpan = 4;
    cell.textContent = users.length ? 'No users match your search.' : 'No registered customer accounts yet.';
    row.append(cell);
    rows.append(row);
    return;
  }
  visibleUsers.forEach(user => {
    const row = document.createElement('tr');
    addCell(row, user.name);
    addCell(row, user.email);
    addCell(row, user.phone);
    addCell(row, formattedTimestamp(user.registeredAt));
    rows.append(row);
  });
}

function renderRiders() {
  const query = document.querySelector('#rider-search').value.trim().toLowerCase();
  const rows = document.querySelector('#rider-rows');
  const visibleRiders = riders.filter(rider => [rider.name, rider.email, rider.phone, rider.vehicle, rider.area, rider.status].join(' ').toLowerCase().includes(query));
  rows.replaceChildren();
  if (!visibleRiders.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'empty-cell';
    cell.colSpan = 9;
    cell.textContent = riders.length ? 'No riders match your search.' : 'No rider applications yet.';
    row.append(cell);
    rows.append(row);
    return;
  }
  visibleRiders.forEach(rider => {
    const row = document.createElement('tr');
    addCell(row, rider.name);
    addCell(row, rider.email);
    addCell(row, rider.phone);
    addCell(row, rider.license);
    addCell(row, rider.vehicle);
    addCell(row, rider.area);
    const statusCell = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'rider-status-pill';
    pill.dataset.status = rider.status;
    pill.textContent = rider.status;
    statusCell.append(pill);
    row.append(statusCell);
    addCell(row, formattedTimestamp(rider.registeredAt));
    const reviewCell = document.createElement('td');
    if (rider.status === 'Pending review') {
      const actions = document.createElement('div');
      actions.className = 'application-actions';
      [['Approved', 'Accept', 'accept-rider'], ['Declined', 'Decline', 'decline-rider']].forEach(([status, label, className]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.setAttribute('aria-label', `${label} rider application for ${rider.name}`);
        button.addEventListener('click', async () => {
          actions.querySelectorAll('button').forEach(action => { action.disabled = true; });
          try {
            await api.request(`/api/admin/riders/${encodeURIComponent(rider.id)}/status`, {
              method: 'PATCH',
              body: JSON.stringify({ status }),
            });
            await refreshWorkspace();
          } catch (error) {
            actions.querySelectorAll('button').forEach(action => { action.disabled = false; });
            window.alert(error.message);
          }
        });
        actions.append(button);
      });
      reviewCell.append(actions);
    } else {
      reviewCell.textContent = rider.status === 'Approved' ? 'Dashboard active' : 'Application declined';
    }
    row.append(reviewCell);
    rows.append(row);
  });
}

function renderDelivered() {
  const deliveredOrders = orders.filter(order => currentStatus(order) === 'Delivered');
  const rows = document.querySelector('#delivered-rows');
  document.querySelector('#delivered-count').textContent = `${deliveredOrders.length} delivered`;
  rows.replaceChildren();
  if (!deliveredOrders.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'empty-cell';
    cell.colSpan = 5;
    cell.textContent = 'No delivered orders yet.';
    row.append(cell);
    rows.append(row);
    return;
  }
  deliveredOrders.forEach(order => {
    const row = document.createElement('tr');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Open delivered request ${order.reference}`);
    row.addEventListener('click', () => {
      setAdminView('orders');
      statusFilter.value = 'Delivered';
      selectOrder(order.id);
    });
    addCell(row, order.reference, 'request-ref');
    addCell(row, `${order.quantity} × ${order.item}`);
    addCell(row, order.name || order.email);
    addCell(row, formattedDate(order.date));
    addCell(row, `${order.pickup} → ${order.delivery}`);
    rows.append(row);
  });
}

function renderNotifications() {
  const list = document.querySelector('#notification-list');
  list.replaceChildren();
  if (!notifications.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-cell';
    empty.textContent = 'No messages sent yet.';
    list.append(empty);
    return;
  }
  notifications.forEach(notification => {
    const card = document.createElement('article');
    card.className = 'notification-card';
    const title = document.createElement('h3');
    title.textContent = notification.subject;
    const message = document.createElement('p');
    message.textContent = notification.message;
    const meta = document.createElement('div');
    meta.className = 'notification-meta';
    const audience = document.createElement('span');
    audience.textContent = `${notification.recipient_count ?? notification.recipientCount} recipients · ${notification.audience_label || notification.audienceLabel}`;
    const date = document.createElement('span');
    date.textContent = formattedTimestamp(notification.created_at || notification.createdAt);
    meta.append(audience, date);
    card.append(title, message, meta);
    list.append(card);
  });
}

function renderRegistrations() {
  const list = document.querySelector('#registration-list');
  const summary = document.querySelector('#registration-summary');
  summary.textContent = `${registrations.length} recent customer and rider ${registrations.length === 1 ? 'registration' : 'registrations'}`;
  list.replaceChildren();
  if (!registrations.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-cell';
    empty.textContent = 'No customer or rider registrations yet.';
    list.append(empty);
    return;
  }
  registrations.forEach(registration => {
    const card = document.createElement('article');
    card.className = 'registration-card';
    const heading = document.createElement('div');
    heading.className = 'registration-card-heading';
    const name = document.createElement('h3');
    name.textContent = registration.name;
    const type = document.createElement('span');
    type.className = 'registration-type';
    type.textContent = registration.type;
    heading.append(name, type);
    const email = document.createElement('p');
    email.textContent = registration.email;
    const phone = document.createElement('p');
    phone.textContent = registration.phone;
    const detail = document.createElement('p');
    detail.className = 'registration-detail';
    detail.textContent = registration.type === 'Rider'
      ? `${registration.vehicle} · ${registration.area} · Driving licence: ${registration.license} · ${registration.status}`
      : 'Customer account';
    const date = document.createElement('time');
    date.dateTime = new Date(registration.registeredAt).toISOString();
    date.textContent = formattedTimestamp(registration.registeredAt);
    card.append(heading, email, phone, detail, date);
    list.append(card);
  });
}

function setAdminView(view) {
  document.querySelectorAll('[data-admin-panel]').forEach(panel => {
    panel.hidden = panel.dataset.adminPanel !== view;
  });
  document.querySelectorAll('[data-admin-view]').forEach(button => {
    const active = button.dataset.adminView === view;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  const titles = {
    orders: ['Orders', 'Review requests, coordinate routes, and update delivery status.'],
    users: ['Users', 'Customer accounts registered on this site.'],
    riders: ['Riders', 'Review rider applications and contact details.'],
    notifications: ['Notifications', 'Send a message to registered customers and riders.'],
    delivered: ['Delivered', 'Orders marked as delivered.'],
  };
  document.querySelector('#section-title').textContent = titles[view][0];
  document.querySelector('#section-summary').textContent = titles[view][1];
}

async function refreshWorkspace() {
  const [orderResult, userResult, riderResult, notificationResult, registrationResult] = await Promise.all([
    api.request('/api/admin/orders'),
    api.request('/api/admin/users'),
    api.request('/api/admin/riders'),
    api.request('/api/admin/notifications'),
    api.request('/api/admin/registrations'),
  ]);
  orders = orderResult.orders;
  users = userResult.users;
  riders = riderResult.riders;
  notifications = notificationResult.notifications;
  registrations = registrationResult.registrations;
  renderMetrics();
  renderQueue();
  renderUsers();
  renderRiders();
  renderDelivered();
  renderNotifications();
  renderRegistrations();
  const selected = orders.find(order => order.id === selectedOrderId) || orders[0];
  if (selected) {
    selectedOrderId = selected.id;
    renderDetail(selected);
  } else {
    selectedOrderId = null;
    detailPanel.innerHTML = '<div class="detail-empty"><span class="detail-mark" aria-hidden="true">↗</span><h2>Select a request</h2><p>Choose a row to review its item photo, customer details, and route.</p></div>';
  }
}

document.querySelectorAll('[data-admin-view]').forEach(button => {
  button.addEventListener('click', () => setAdminView(button.dataset.adminView));
});
searchInput.addEventListener('input', renderQueue);
statusFilter.addEventListener('change', renderQueue);
document.querySelector('#user-search').addEventListener('input', renderUsers);
document.querySelector('#rider-search').addEventListener('input', renderRiders);
document.querySelector('#refresh-orders').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await refreshWorkspace();
  } catch (error) {
    document.querySelector('#queue-summary').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
document.querySelector('#notification-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const statusMessage = document.querySelector('#notification-status');
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api.request('/api/admin/notifications', {
      method: 'POST',
      body: JSON.stringify({
        subject: values.get('subject'),
        audience: values.get('audience'),
        message: values.get('message'),
      }),
    });
    notifications.unshift(result.notification);
    renderNotifications();
    form.reset();
    api.setStatus(statusMessage, `Message sent to ${result.notification.recipientCount} recipient${result.notification.recipientCount === 1 ? '' : 's'}.`, 'success');
  } catch (error) {
    api.setStatus(statusMessage, error.message);
  } finally {
    submit.disabled = false;
  }
});

setAdminView('orders');
window.adminSessionReady.then(refreshWorkspace).catch(error => {
  document.querySelector('#queue-summary').textContent = error.message;
});
