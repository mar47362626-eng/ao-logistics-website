const menuToggle = document.querySelector('.menu-toggle');
const navigation = document.querySelector('.primary-nav');
const authView = document.querySelector('#auth-view');
const dashboard = document.querySelector('#customer-dashboard');
let currentUser = null;
let selectedPhotoUrl = '';

menuToggle.addEventListener('click', () => {
  const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
  menuToggle.setAttribute('aria-expanded', String(!isOpen));
  menuToggle.setAttribute('aria-label', isOpen ? 'Open navigation' : 'Close navigation');
  navigation.classList.toggle('is-open', !isOpen);
});

navigation.addEventListener('click', event => {
  const link = event.target.closest('a');
  if (link) {
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Open navigation');
    navigation.classList.remove('is-open');
  }
});

document.querySelector('#year').textContent = new Date().getFullYear();

function showMessage(selector, message) {
  api.setStatus(document.querySelector(selector), message);
}

function updateNavigationForSession() {
  const loginLink = document.querySelector('#nav-login');
  const accountLink = document.querySelector('#nav-account');
  loginLink.textContent = currentUser ? 'My account' : 'Sign in';
  if (currentUser) {
    accountLink.removeAttribute('data-auth-view');
    accountLink.dataset.signOut = 'true';
    accountLink.textContent = 'Log out';
  } else {
    accountLink.removeAttribute('data-sign-out');
    accountLink.dataset.authView = 'register';
    accountLink.innerHTML = 'Create account <span aria-hidden="true">↗</span>';
  }
}

function setAuthView(view) {
  const registerSelected = view === 'register';
  document.querySelector('#login-form').hidden = registerSelected;
  document.querySelector('#register-form').hidden = !registerSelected;
  document.querySelectorAll('.portal-tab').forEach(tab => {
    const active = tab.dataset.authView === view;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  showMessage('#login-status', '');
  showMessage('#register-status', '');
}

function closeAuthScreen() {
  document.body.classList.remove('auth-screen-active');
  history.replaceState(null, '', window.location.pathname + window.location.search);
  window.scrollTo(0, 0);
}

async function loadCurrentUser() {
  try {
    currentUser = (await api.request('/api/auth/me')).user;
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) throw error;
    currentUser = null;
  }
  updateNavigationForSession();
  return currentUser;
}

async function openAuthScreen(view) {
  document.body.classList.add('auth-screen-active');
  window.scrollTo(0, 0);
  try {
    await loadCurrentUser();
    if (currentUser) {
      await showDashboard();
      return;
    }
  } catch {
    showMessage('#login-status', 'The account service is unavailable right now. Please try again shortly.');
  }
  dashboard.hidden = true;
  authView.hidden = false;
  setAuthView(view);
  document.querySelector(`#${view}-form input`)?.focus();
}

async function loadOrders() {
  return (await api.request('/api/customer/orders')).orders;
}

async function renderOrders() {
  const list = document.querySelector('#order-list');
  list.replaceChildren();
  const orders = await loadOrders();
  document.querySelector('#order-count').textContent = `${orders.length} ${orders.length === 1 ? 'request' : 'requests'}`;
  if (!orders.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-orders';
    empty.textContent = 'Your delivery requests will appear here.';
    list.append(empty);
    return;
  }
  orders.forEach(order => {
    const card = document.createElement('article');
    card.className = 'order-card';
    const image = document.createElement('img');
    image.crossOrigin = 'use-credentials';
    image.src = api.url(`/api/orders/${encodeURIComponent(order.id)}/photo`);
    image.alt = `Photo of ${order.item}`;
    const info = document.createElement('div');
    const title = document.createElement('h4');
    title.textContent = `${order.quantity} × ${order.item}`;
    const route = document.createElement('p');
    route.textContent = `${order.pickup} → ${order.delivery}`;
    const pickupDate = document.createElement('p');
    pickupDate.textContent = `Pickup date: ${order.date}`;
    const status = document.createElement('span');
    status.className = 'order-status';
    status.textContent = order.status;
    const reference = document.createElement('span');
    reference.className = 'order-reference';
    reference.textContent = order.reference;
    info.append(title, route, pickupDate, status);
    card.append(image, info, reference);
    list.append(card);
  });
}

async function renderCustomerNotifications() {
  const messages = (await api.request('/api/customer/notifications')).notifications;
  const list = document.querySelector('#customer-notifications');
  list.replaceChildren();
  document.querySelector('#notification-count').textContent = `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`;
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-orders';
    empty.textContent = 'No messages yet.';
    list.append(empty);
    return;
  }
  messages.forEach(message => {
    const card = document.createElement('article');
    card.className = 'customer-notification';
    const subject = document.createElement('h4');
    subject.textContent = message.subject;
    const body = document.createElement('p');
    body.textContent = message.message;
    const date = document.createElement('time');
    date.dateTime = new Date(message.created_at).toISOString();
    date.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(message.created_at));
    card.append(subject, body, date);
    list.append(card);
  });
}

async function showDashboard() {
  if (!currentUser) return;
  authView.hidden = true;
  dashboard.hidden = false;
  document.querySelector('#customer-name').textContent = currentUser.name.split(' ')[0];
  const orderForm = document.querySelector('#order-form');
  orderForm.hidden = true;
  document.querySelector('#show-order-form').setAttribute('aria-expanded', 'false');
  orderForm.elements.phone.value = currentUser.phone;
  orderForm.elements.pickupEmail.value = currentUser.email;
  const today = new Date();
  orderForm.elements.date.min = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  showMessage('#order-status', '');
  try {
    await Promise.all([renderOrders(), renderCustomerNotifications()]);
  } catch {
    showMessage('#order-status', 'We could not load your account details. Refresh the page to try again.');
  }
}

document.querySelectorAll('.portal-tab').forEach(tab => {
  tab.addEventListener('click', () => setAuthView(tab.dataset.authView));
});

document.querySelector('#show-order-form').addEventListener('click', event => {
  const button = event.currentTarget;
  const orderForm = document.querySelector('#order-form');
  orderForm.hidden = !orderForm.hidden;
  button.setAttribute('aria-expanded', String(!orderForm.hidden));
  button.textContent = orderForm.hidden ? 'Place an order' : 'Close order form';
  if (!orderForm.hidden) orderForm.querySelector('input[name="item"]').focus();
});

document.querySelector('#register-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  if (values.get('password') !== values.get('confirmPassword')) {
    showMessage('#register-status', 'Those passwords do not match. Please check and try again.');
    return;
  }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: values.get('name'),
        phone: values.get('phone'),
        email: values.get('email'),
        password: values.get('password'),
      }),
    });
    currentUser = result.user;
    form.reset();
    updateNavigationForSession();
    const welcomeNotice = document.querySelector('#account-welcome-notice');
    welcomeNotice.textContent = result.warning
      ? `Your account is ready, but we could not send a welcome email to ${result.user.email}. You can continue using your account.`
      : `Your account is ready. We asked our email service to send a welcome message to ${result.user.email}. If it does not arrive in a few minutes, check your Spam or Junk folder.`;
    welcomeNotice.hidden = false;
    closeAuthScreen();
    await showDashboard();
  } catch (error) {
    showMessage('#register-status', error.message);
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: values.get('email'), password: values.get('password') }),
    });
    currentUser = result.user;
    document.querySelector('#account-welcome-notice').hidden = true;
    updateNavigationForSession();
    await showDashboard();
  } catch (error) {
    showMessage('#login-status', error.message);
  } finally {
    submit.disabled = false;
  }
});

const photoInput = document.querySelector('#order-photo');
photoInput.addEventListener('change', () => {
  const file = photoInput.files[0];
  if (selectedPhotoUrl) URL.revokeObjectURL(selectedPhotoUrl);
  selectedPhotoUrl = '';
  if (!file) {
    document.querySelector('#photo-preview').hidden = true;
    return;
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    photoInput.value = '';
    document.querySelector('#photo-preview').hidden = true;
    showMessage('#order-status', 'Choose a JPG, PNG, or WebP image smaller than 5 MB.');
    return;
  }
  showMessage('#order-status', '');
  selectedPhotoUrl = URL.createObjectURL(file);
  document.querySelector('#photo-preview-image').src = selectedPhotoUrl;
  document.querySelector('#photo-file-name').textContent = file.name;
  document.querySelector('#photo-preview').hidden = false;
});

document.querySelector('#remove-photo').addEventListener('click', () => {
  if (selectedPhotoUrl) URL.revokeObjectURL(selectedPhotoUrl);
  selectedPhotoUrl = '';
  photoInput.value = '';
  document.querySelector('#photo-preview').hidden = true;
});

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read the selected photo.'));
    reader.readAsDataURL(file);
  });
}

document.querySelector('#order-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const photo = photoInput.files[0];
  if (!photo || !['image/jpeg', 'image/png', 'image/webp'].includes(photo.type) || photo.size > 5 * 1024 * 1024) {
    showMessage('#order-status', 'Add a JPG, PNG, or WebP item photo under 5 MB before saving your request.');
    return;
  }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api.request('/api/customer/orders', {
      method: 'POST',
      body: JSON.stringify({
        item: values.get('item'),
        quantity: values.get('quantity'),
        description: values.get('description'),
        pickup: values.get('pickup'),
        delivery: values.get('delivery'),
        pickupEmail: values.get('pickupEmail'),
        deliveryEmail: values.get('deliveryEmail'),
        date: values.get('date'),
        phone: values.get('phone'),
        notes: values.get('notes'),
        photo: await fileAsDataUrl(photo),
      }),
    });
    form.reset();
    document.querySelector('#photo-preview').hidden = true;
    if (selectedPhotoUrl) URL.revokeObjectURL(selectedPhotoUrl);
    selectedPhotoUrl = '';
    form.elements.phone.value = currentUser.phone;
    form.elements.pickupEmail.value = currentUser.email;
    showMessage('#order-status', '');
    showMessage(
      '#order-confirmation-message',
      result.warning
        ? `Request ${result.order.reference} was saved, but one or more emails could not be sent. View its status under My account.`
        : `Request ${result.order.reference} was sent to A&M. View its status under My account.`,
    );
    document.querySelector('#order-confirmation').hidden = false;
    closeAuthScreen();
    await renderOrders();
  } catch (error) {
    showMessage('#order-status', error.message);
  } finally {
    submit.disabled = false;
  }
});

async function signOut() {
  try {
    await api.request('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ role: 'customer' }),
    });
    currentUser = null;
    updateNavigationForSession();
    dashboard.hidden = true;
    authView.hidden = false;
    setAuthView('login');
  } catch {
    showMessage('#order-status', 'Could not sign out right now. Please try again.');
  }
}

document.querySelector('#sign-out').addEventListener('click', signOut);

document.addEventListener('click', event => {
  const signOutLink = event.target.closest('a[data-sign-out]');
  if (signOutLink) {
    event.preventDefault();
    signOut();
    closeAuthScreen();
    return;
  }
  const authLink = event.target.closest('a[data-auth-view]');
  if (authLink) {
    event.preventDefault();
    openAuthScreen(authLink.dataset.authView);
  }
});

document.querySelector('#portal-back').addEventListener('click', closeAuthScreen);
updateNavigationForSession();
loadCurrentUser().then(user => {
  if (user) {
    document.body.classList.add('auth-screen-active');
    return showDashboard();
  }
}).catch(() => {
  showMessage('#login-status', 'The account service is unavailable right now. Please try again shortly.');
});
