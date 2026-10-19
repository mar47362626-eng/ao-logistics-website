const pageType = document.body.dataset.adminPage;
let records = [];
let savedNotifications = [];
let registrations = [];

function prettyDate(value, withTime = false) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, withTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

function addCell(row, value, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = value || 'Not provided';
  row.append(cell);
}

function renderUsers() {
  const query = document.querySelector('#user-search').value.trim().toLowerCase();
  const rows = document.querySelector('#user-rows');
  const matches = records.filter(user => [user.name, user.email, user.phone].join(' ').toLowerCase().includes(query));
  document.querySelector('#users-summary').textContent = `${records.length} registered ${records.length === 1 ? 'customer' : 'customers'}`;
  rows.replaceChildren();
  if (!matches.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'empty-cell';
    cell.colSpan = 4;
    cell.textContent = records.length ? 'No users match your search.' : 'No customer accounts registered yet.';
    row.append(cell);
    rows.append(row);
    return;
  }
  matches.forEach(user => {
    const row = document.createElement('tr');
    addCell(row, user.name);
    addCell(row, user.email);
    addCell(row, user.phone);
    addCell(row, prettyDate(user.registeredAt, true));
    rows.append(row);
  });
}

function renderRiders() {
  const query = document.querySelector('#rider-search').value.trim().toLowerCase();
  const rows = document.querySelector('#rider-rows');
  const matches = records.filter(rider => [rider.name, rider.email, rider.phone, rider.vehicle, rider.area, rider.status].join(' ').toLowerCase().includes(query));
  document.querySelector('#riders-summary').textContent = `${records.length} rider ${records.length === 1 ? 'registration' : 'registrations'}`;
  rows.replaceChildren();
  if (!matches.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'empty-cell';
    cell.colSpan = 9;
    cell.textContent = records.length ? 'No riders match your search.' : 'No rider registrations yet.';
    row.append(cell);
    rows.append(row);
    return;
  }
  matches.forEach(rider => {
    const row = document.createElement('tr');
    addCell(row, rider.name);
    addCell(row, rider.email);
    addCell(row, rider.phone);
    addCell(row, rider.license);
    addCell(row, rider.vehicle);
    addCell(row, rider.area);
    const statusCell = document.createElement('td');
    const statusPill = document.createElement('span');
    statusPill.className = 'rider-status-pill';
    statusPill.dataset.status = rider.status;
    statusPill.textContent = rider.status;
    statusCell.append(statusPill);
    row.append(statusCell);
    addCell(row, prettyDate(rider.registeredAt, true));
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
            await refreshPage();
          } catch (error) {
            actions.querySelectorAll('button').forEach(action => { action.disabled = false; });
            document.querySelector('#riders-summary').textContent = error.message;
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
  const delivered = records.filter(order => order.status === 'Delivered');
  const rows = document.querySelector('#delivered-rows');
  document.querySelector('#delivered-count').textContent = `${delivered.length} delivered`;
  document.querySelector('#delivered-summary').textContent = `${delivered.length} completed ${delivered.length === 1 ? 'delivery' : 'deliveries'}`;
  rows.replaceChildren();
  if (!delivered.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'empty-cell';
    cell.colSpan = 6;
    cell.textContent = 'No delivered orders yet. Update an order to Delivered in the Orders workspace.';
    row.append(cell);
    rows.append(row);
    return;
  }
  delivered.sort((first, second) => (second.deliveredAt || second.createdAt) - (first.deliveredAt || first.createdAt)).forEach(order => {
    const row = document.createElement('tr');
    addCell(row, order.reference, 'request-ref');
    addCell(row, `${order.quantity} × ${order.item}`);
    addCell(row, order.email);
    addCell(row, prettyDate(order.date));
    addCell(row, `${order.pickup} → ${order.delivery}`);
    addCell(row, prettyDate(order.deliveredAt || order.updatedAt || order.createdAt, true));
    rows.append(row);
  });
}

function renderNotifications() {
  const list = document.querySelector('#notification-list');
  list.replaceChildren();
  document.querySelector('#notifications-summary').textContent = `${savedNotifications.length} saved ${savedNotifications.length === 1 ? 'message' : 'messages'}`;
  if (!savedNotifications.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-cell';
    empty.textContent = 'No messages sent yet.';
    list.append(empty);
    return;
  }
  savedNotifications.forEach(notification => {
    const card = document.createElement('article');
    card.className = 'notification-card';
    const title = document.createElement('h3');
    title.textContent = notification.subject;
    const message = document.createElement('p');
    message.textContent = notification.message;
    const meta = document.createElement('div');
    meta.className = 'notification-meta';
    const recipients = document.createElement('span');
    recipients.textContent = `${notification.recipient_count ?? notification.recipientCount} recipients · ${notification.audience_label || notification.audienceLabel}`;
    const date = document.createElement('span');
    date.textContent = prettyDate(notification.created_at || notification.createdAt, true);
    meta.append(recipients, date);
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
    date.textContent = prettyDate(registration.registeredAt, true);
    card.append(heading, email, phone, detail, date);
    list.append(card);
  });
}

if (pageType === 'notifications') {
  window.setInterval(async () => {
    try {
      registrations = (await api.request('/api/admin/registrations')).registrations;
      renderRegistrations();
    } catch (error) {
      document.querySelector('#registration-summary').textContent = `Could not refresh registrations: ${error.message}`;
    }
  }, 30000);
}

async function refreshPage() {
  const button = document.querySelector('#refresh-page');
  if (button) button.disabled = true;
  try {
    if (pageType === 'users') {
      records = (await api.request('/api/admin/users')).users;
      renderUsers();
    } else if (pageType === 'riders') {
      records = (await api.request('/api/admin/riders')).riders;
      renderRiders();
    } else if (pageType === 'delivered') {
      records = (await api.request('/api/admin/orders')).orders;
      renderDelivered();
    } else if (pageType === 'notifications') {
      const [notificationResult, registrationResult] = await Promise.all([
        api.request('/api/admin/notifications'),
        api.request('/api/admin/registrations'),
      ]);
      savedNotifications = notificationResult.notifications;
      registrations = registrationResult.registrations;
      renderNotifications();
      renderRegistrations();
    }
  } catch (error) {
    const summary = document.querySelector(`#${pageType}-summary`);
    if (summary) summary.textContent = error.message;
  } finally {
    if (button) button.disabled = false;
  }
}

if (pageType === 'users') document.querySelector('#user-search').addEventListener('input', renderUsers);
if (pageType === 'riders') document.querySelector('#rider-search').addEventListener('input', renderRiders);
document.querySelector('#refresh-page').addEventListener('click', refreshPage);

if (pageType === 'notifications') {
  document.querySelector('#notification-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const status = document.querySelector('#notification-status');
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
      savedNotifications.unshift(result.notification);
      renderNotifications();
      form.reset();
      api.setStatus(status, `Message sent to ${result.notification.recipientCount} recipient${result.notification.recipientCount === 1 ? '' : 's'}.`, 'success');
    } catch (error) {
      api.setStatus(status, error.message);
    } finally {
      submit.disabled = false;
    }
  });
}

window.adminSessionReady.then(refreshPage).catch(error => {
  if (error.status !== 401 && error.status !== 403) console.error(error);
});
