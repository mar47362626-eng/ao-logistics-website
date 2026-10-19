const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { createDatabase } = require('./db');
const { brevoApiFailure, createApp, seedAdmin, sendBrevoEmail } = require('./server');

let database;
let server;
let baseUrl;
let emails;
let failDeliveredEmail;
let failInTransitEmail;
let failNewOrderEmail;
let failRiderApplicationEmail;
let failCustomerWelcomeEmail;

async function request(route, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = response.status === 204 ? null : await response.json();
  const setCookie = response.headers.get('set-cookie');
  return { response, result, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

before(async () => {
  process.env.ADMIN_EMAIL = 'admin@example.com';
  process.env.ADMIN_PASSWORD = 'test-admin-password-123';
  process.env.ALLOWED_ORIGINS = 'https://mar47362626-eng.github.io';
  emails = [];
  failDeliveredEmail = false;
  failInTransitEmail = false;
  failNewOrderEmail = false;
  failRiderApplicationEmail = false;
  failCustomerWelcomeEmail = false;
  database = createDatabase(':memory:');
  await seedAdmin(database);
  server = createApp(database, {
    sendEmail: async email => {
      if (failDeliveredEmail && /delivered/i.test(email.subject)) throw new Error('Simulated mail outage.');
      if (failInTransitEmail && /on its way/i.test(email.subject) && email.inlineImage) {
        throw new Error('Simulated status-email outage.');
      }
      if (failNewOrderEmail && /delivery request|new delivery request/i.test(email.subject)) {
        throw new Error('Simulated new-order email outage.');
      }
      if (failRiderApplicationEmail && /rider application received/i.test(email.subject)) {
        throw new Error('Simulated rider application email outage.');
      }
      if (failCustomerWelcomeEmail && /welcome to a&m logistics/i.test(email.subject)) {
        throw new Error('Simulated welcome email outage.');
      }
      emails.push(email);
    },
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  database.close();
});

test('separate site pages are served and protected APIs enforce roles', async () => {
  const [home, riderPage, cleanAdminPage, cleanRiderPage, adminData, databaseFile, jsonDatabaseFile] = await Promise.all([
    fetch(`${baseUrl}/index.html`),
    fetch(`${baseUrl}/rider.html`),
    fetch(`${baseUrl}/admin`),
    fetch(`${baseUrl}/rider`),
    request('/api/admin/orders'),
    fetch(`${baseUrl}/data/ao-logistics.sqlite`),
    fetch(`${baseUrl}/data/users.json`),
  ]);
  assert.equal(home.status, 200);
  assert.equal(riderPage.status, 200);
  assert.equal(cleanAdminPage.status, 200);
  assert.equal(cleanRiderPage.status, 200);
  assert.match(await home.text(), /We move/);
  assert.match(await riderPage.text(), /RIDER APPLICATION/);
  assert.match(await cleanAdminPage.text(), /A&M Logistics/);
  assert.match(await cleanRiderPage.text(), /RIDER APPLICATION/);
  assert.equal(adminData.response.status, 401);
  const signedOutCustomer = await request('/api/auth/me');
  assert.equal(signedOutCustomer.response.status, 200);
  assert.equal(signedOutCustomer.result.user, null);
  const riderSession = await request('/api/rider/me');
  assert.equal(riderSession.response.status, 200);
  assert.equal(riderSession.result.rider, null);
  assert.equal(databaseFile.status, 404);
  assert.equal(jsonDatabaseFile.status, 404);
});

test('favicon requests redirect to the branded SVG icon', async () => {
  const legacyIcon = await fetch(`${baseUrl}/favicon.ico`, { redirect: 'manual' });
  assert.equal(legacyIcon.status, 302);
  assert.equal(legacyIcon.headers.get('location'), '/favicon.svg');

  const icon = await fetch(`${baseUrl}/favicon.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await icon.text(), /<svg/);
});

test('clean admin and rider URLs normalize trailing slashes and old file URLs redirect', async () => {
  const [admin, rider, oldAdmin, oldRider] = await Promise.all([
    fetch(`${baseUrl}/admin/`, { redirect: 'manual' }),
    fetch(`${baseUrl}/rider/`, { redirect: 'manual' }),
    fetch(`${baseUrl}/admin.html`, { redirect: 'manual' }),
    fetch(`${baseUrl}/rider.html`, { redirect: 'manual' }),
  ]);
  assert.equal(admin.status, 301);
  assert.equal(admin.headers.get('location'), '/admin');
  assert.equal(rider.status, 301);
  assert.equal(rider.headers.get('location'), '/rider');
  assert.equal(oldAdmin.status, 301);
  assert.equal(oldAdmin.headers.get('location'), '/admin');
  assert.equal(oldRider.status, 301);
  assert.equal(oldRider.headers.get('location'), '/rider');
});

test('GitHub Pages origin is allowed for credentialed API calls and untrusted origins are rejected', async () => {
  const allowedOrigin = 'https://mar47362626-eng.github.io';
  const preflight = await fetch(`${baseUrl}/api/auth/me`, {
    method: 'OPTIONS',
    headers: {
      Origin: allowedOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');

  const sameOrigin = await fetch(`${baseUrl}/api/auth/me`, {
    method: 'OPTIONS',
    headers: { Origin: baseUrl },
  });
  assert.equal(sameOrigin.status, 204);
  assert.equal(sameOrigin.headers.get('access-control-allow-origin'), baseUrl);

  const blocked = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Origin: 'https://untrusted.example' },
  });
  assert.equal(blocked.status, 403);
});

test('admin accounts can be created through the registration endpoint', async () => {
  const unauthenticatedRegistration = await request('/api/auth/admin/register', {
    method: 'POST',
    body: {
      name: 'Unauthorized Admin',
      email: 'unauthorized-admin@example.com',
      password: 'new-admin-password-123',
    },
  });

  test('Brevo authorization errors explain whether the API key or server IP needs attention', () => {
    assert.match(brevoApiFailure(401, 'Key not found'), /transactional API key/i);
    assert.match(brevoApiFailure(403, 'IP address not authorized'), /Render outbound IP/i);
    assert.match(brevoApiFailure(500), /could not send the email/i);
  });

  test('order email uses the Brevo API with the package photo attached without SMTP credentials', async () => {
    const environmentNames = ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_SENDER_NAME', 'BREVO_SMTP_LOGIN', 'BREVO_SMTP_KEY', 'BREVO_SMTP_PORT'];
    const previousEnvironment = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
    const originalFetch = global.fetch;
    let apiRequest;
    process.env.BREVO_API_KEY = 'test-transactional-key';
    process.env.BREVO_SENDER_EMAIL = 'sender@example.com';
    process.env.BREVO_SENDER_NAME = 'A&M Logistics';
    for (const name of environmentNames.slice(3)) delete process.env[name];
    global.fetch = async (url, options) => {
      apiRequest = { url, options, body: JSON.parse(options.body) };
      return new Response('{}', { status: 201 });
    };

    try {
      await sendBrevoEmail({
        to: 'customer@example.com',
        subject: 'Delivery request received',
        text: 'Your delivery is in.',
        html: '<p>Your delivery is in.</p><img src="cid:package-photo" alt="Package photo" width="500">',
        inlineImage: {
          name: 'package-AO-TEST-01.jpg',
          content: 'dGVzdC1pbWFnZQ==',
          contentType: 'image/jpeg',
          cid: 'package-photo',
        },
      });

      assert.equal(apiRequest.url, 'https://api.brevo.com/v3/smtp/email');
      assert.equal(apiRequest.options.headers['api-key'], 'test-transactional-key');
      assert.deepEqual(apiRequest.body.attachment, [{
        name: 'package-AO-TEST-01.jpg',
        content: 'dGVzdC1pbWFnZQ==',
      }]);
      assert.doesNotMatch(apiRequest.body.htmlContent, /cid:package-photo/);
      assert.match(apiRequest.body.htmlContent, /photo is attached to this email/i);
      assert.match(apiRequest.body.textContent, /photo is attached to this email/i);
    } finally {
      global.fetch = originalFetch;
      for (const name of environmentNames) {
        if (previousEnvironment[name] === undefined) delete process.env[name];
        else process.env[name] = previousEnvironment[name];
      }
    }
  });

  test('customer account creation succeeds if the welcome email service is unavailable', async () => {
    failCustomerWelcomeEmail = true;
    const registration = await request('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Email Outage Customer',
        phone: '555-0144',
        email: 'email-outage-customer@example.com',
        password: 'email-outage-password-123',
      },
    });
    failCustomerWelcomeEmail = false;
    assert.equal(registration.response.status, 201);
    assert.match(registration.cookie, /^ao_customer_session=/);
    assert.equal(registration.result.user.email, 'email-outage-customer@example.com');
    assert.match(registration.result.warning, /account was created/i);
    const profile = await request('/api/auth/me', { cookie: registration.cookie });
    assert.equal(profile.response.status, 200);
    assert.equal(profile.result.user.email, 'email-outage-customer@example.com');
  });
  assert.equal(unauthenticatedRegistration.response.status, 403);

  const existingAdminLogin = await request('/api/auth/admin/login', {
    method: 'POST',
    body: { email: 'admin@example.com', password: 'test-admin-password-123' },
  });
  assert.equal(existingAdminLogin.response.status, 200);

  const registeredAdmin = await request('/api/auth/admin/register', {
    method: 'POST',
    cookie: existingAdminLogin.cookie,
    body: {
      name: 'Admin Two',
      email: 'admin2@example.com',
      phone: '555-0199',
      password: 'new-admin-password-123',
    },
  });
  assert.equal(registeredAdmin.response.status, 201);
  assert.match(registeredAdmin.cookie, /^ao_admin_session=/);

  const login = await request('/api/auth/admin/login', {
    method: 'POST',
    body: { email: 'admin2@example.com', password: 'new-admin-password-123' },
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.result.user.email, 'admin2@example.com');
});

test('the first admin can register without an existing admin session', async () => {
  const bootstrapDatabase = createDatabase(':memory:');
  const bootstrapServer = createApp(bootstrapDatabase, { sendEmail: async () => {} }).listen(0, '127.0.0.1');
  await new Promise(resolve => bootstrapServer.once('listening', resolve));
  const bootstrapUrl = `http://127.0.0.1:${bootstrapServer.address().port}`;

  try {
    const response = await fetch(`${bootstrapUrl}/api/auth/admin/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'First Admin',
        email: 'first-admin@example.com',
        password: 'first-admin-password-123',
      }),
    });
    assert.equal(response.status, 201);
    assert.match(response.headers.get('set-cookie'), /^ao_admin_session=/);
  } finally {
    await new Promise((resolve, reject) => bootstrapServer.close(error => error ? reject(error) : resolve()));
    bootstrapDatabase.close();
  }
});

test('customer and rider workflows share orders, assignment, and notifications', async () => {
  const registeredRider = await request('/api/rider/applications', {
    method: 'POST',
    body: {
      name: 'Riley Rider',
      phone: '555-0100',
      email: 'rider@example.com',
      vehicle: 'Bicycle',
      license: 'RIDER-001',
      area: 'Central',
      password: 'rider-password-123',
    },
  });
  assert.equal(registeredRider.response.status, 201);
  assert.equal(emails.at(-1).to, 'rider@example.com');
  assert.match(emails.at(-1).subject, /application received/i);
  assert.equal(registeredRider.result.rider.status, 'Pending review');
  assert.equal('password_hash' in registeredRider.result.rider, false);

  failRiderApplicationEmail = true;
  const savedRiderApplication = await request('/api/rider/applications', {
    method: 'POST',
    body: {
      name: 'Jordan Rider',
      phone: '555-0101',
      email: 'jordan.rider@example.com',
      vehicle: 'Bicycle',
      license: 'RIDER-002',
      area: 'Central',
      password: 'jordan-rider-password-123',
    },
  });
  failRiderApplicationEmail = false;
  assert.equal(savedRiderApplication.response.status, 201);
  assert.equal(savedRiderApplication.result.rider.status, 'Pending review');
  assert.match(savedRiderApplication.result.warning, /application was saved/i);
  const riderLoginAfterEmailFailure = await request('/api/rider/login', {
    method: 'POST',
    body: { email: 'jordan.rider@example.com', password: 'jordan-rider-password-123' },
  });
  assert.equal(riderLoginAfterEmailFailure.response.status, 200);

  const adminLogin = await request('/api/auth/admin/login', {
    method: 'POST',
    body: { email: 'admin@example.com', password: 'test-admin-password-123' },
  });
  assert.equal(adminLogin.response.status, 200);
  const adminCookie = adminLogin.cookie;
  const adminOnCustomerPage = await request('/api/auth/me', { cookie: adminCookie });
  assert.equal(adminOnCustomerPage.response.status, 200);
  assert.equal(adminOnCustomerPage.result.user, null);
  const adminOnRiderPage = await request('/api/rider/me', { cookie: adminCookie });
  assert.equal(adminOnRiderPage.response.status, 200);
  assert.equal(adminOnRiderPage.result.rider, null);
  const riderRegistrations = await request('/api/admin/registrations', { cookie: adminCookie });
  assert.equal(riderRegistrations.response.status, 200);
  assert.equal(riderRegistrations.result.registrations[0].type, 'Rider');
  assert.ok(riderRegistrations.result.registrations.some(registration => registration.license === 'RIDER-001'));
  const riderAdminList = await request('/api/admin/riders', { cookie: adminCookie });
  assert.ok(riderAdminList.result.riders.some(rider => rider.license === 'RIDER-001'));

  const review = await request(`/api/admin/riders/${registeredRider.result.rider.id}/status`, {
    method: 'PATCH',
    body: { status: 'Approved' },
    cookie: adminCookie,
  });
  assert.equal(review.response.status, 200);
  assert.equal(emails.at(-1).to, 'rider@example.com');
  assert.match(emails.at(-1).subject, /approved/i);

  const customer = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Casey Customer', phone: '555-0110', email: 'customer@example.com', password: 'customer-password-123' },
  });
  assert.equal(customer.response.status, 201);
  assert.equal(emails.at(-1).to, 'customer@example.com');
  assert.match(emails.at(-1).subject, /welcome/i);
  assert.match(emails.at(-1).html, /<table role="presentation"/);
  assert.match(emails.at(-1).html, /background:#263b32/);
  assert.match(emails.at(-1).text, /A&M LOGISTICS[\s\S]*Welcome to A&M Logistics/);
  const signedOutCustomer = await request('/api/auth/logout', {
    method: 'POST',
    cookie: customer.cookie,
    body: { role: 'customer' },
  });
  assert.equal(signedOutCustomer.response.status, 204);
  const wrongCustomerPassword = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'CUSTOMER@example.com', password: 'incorrect-password' },
  });
  assert.equal(wrongCustomerPassword.response.status, 401);
  const returningCustomer = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'CUSTOMER@example.com', password: 'customer-password-123' },
  });
  assert.equal(returningCustomer.response.status, 200);
  assert.match(returningCustomer.cookie, /^ao_customer_session=/);
  customer.cookie = returningCustomer.cookie;
  const customerProfile = await request('/api/auth/me', { cookie: customer.cookie });
  assert.equal(customerProfile.response.status, 200);
  assert.equal(customerProfile.result.user.email, 'customer@example.com');
  const forbidden = await request('/api/admin/orders', { cookie: customer.cookie });
  assert.equal(forbidden.response.status, 403);
  const customerRegistration = await request('/api/admin/registrations', { cookie: adminCookie });
  assert.deepEqual(
    customerRegistration.result.registrations.map(registration => registration.type).sort(),
    ['Customer', 'Customer', 'Rider', 'Rider'],
  );

  const order = await request('/api/customer/orders', {
    method: 'POST',
    cookie: customer.cookie,
    body: {
      item: 'Small box',
      quantity: 2,
      description: 'Fragile',
      pickup: 'One Street',
      delivery: 'Two Street',
      pickupEmail: 'pickup@example.com',
      deliveryEmail: 'delivery@example.com',
      date: '2026-10-20',
      phone: '555-0110',
      notes: '',
      photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      // Provide a sample estimated distance (km) so rider earnings can be computed in tests.
      deliveryDistanceKm: 2.4,
    },
  });
  assert.equal(order.response.status, 201);
  assert.equal(order.result.order.status, 'Received');
  assert.deepEqual(
    emails.slice(-3).map(email => email.to).sort(),
    ['admin2@example.com', 'admin@example.com', 'customer@example.com'],
  );
  for (const orderEmail of emails.slice(-3)) {
    assert.equal(orderEmail.inlineImage.name, `package-${order.result.order.reference}.png`);
    assert.match(orderEmail.html, /<img[^>]+src="cid:package-photo"/);
  }
  assert.equal(order.result.order.pickupEmail, 'pickup@example.com');
  assert.equal(order.result.order.deliveryEmail, 'delivery@example.com');

  const assignment = await request(`/api/admin/orders/${order.result.order.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'Confirmed', riderId: registeredRider.result.rider.id },
  });
  assert.equal(assignment.response.status, 200);
  assert.equal(assignment.result.order.riderName, 'Riley Rider');
  assert.ok(emails.some(email => email.to === 'customer@example.com' && /confirmed/i.test(email.subject)));
  assert.equal(emails.at(-1).to, 'rider@example.com');
  assert.match(emails.at(-1).subject, /assigned/i);
  assert.equal(emails.at(-1).inlineImage.name, `package-${order.result.order.reference}.png`);
  assert.match(emails.at(-1).html, /<img[^>]+src="cid:package-photo"/);

  const riderLogin = await request('/api/rider/login', {
    method: 'POST',
    body: { email: 'rider@example.com', password: 'rider-password-123' },
  });
  assert.equal(riderLogin.response.status, 200);
  assert.match(riderLogin.cookie, /^ao_rider_session=/);
  assert.match(customer.cookie, /^ao_customer_session=/);
  assert.match(adminCookie, /^ao_admin_session=/);
  const combinedCookies = `${customer.cookie}; ${adminCookie}; ${riderLogin.cookie}`;
  const riderSession = await request('/api/rider/me', { cookie: riderLogin.cookie });
  assert.equal(riderSession.response.status, 200);
  assert.equal(riderSession.result.rider.email, 'rider@example.com');
  assert.equal((await request('/api/auth/me', { cookie: combinedCookies })).response.status, 200);
  assert.equal((await request('/api/auth/admin/me', { cookie: combinedCookies })).response.status, 200);
  const deliveries = await request('/api/rider/deliveries', { cookie: riderLogin.cookie });
  assert.equal(deliveries.response.status, 200);
  assert.equal(deliveries.result.orders[0].id, order.result.order.id);
  const riderPhoto = await fetch(`${baseUrl}/api/orders/${order.result.order.id}/photo`, {
    headers: { Cookie: riderLogin.cookie },
  });
  assert.equal(riderPhoto.status, 200);
  assert.equal(riderPhoto.headers.get('content-type'), 'image/png');
  assert.deepEqual(
    Buffer.from(await riderPhoto.arrayBuffer()).subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const pickupCodeSent = await request(`/api/rider/orders/${order.result.order.id}/handoff-code`, {
    method: 'POST',
    cookie: riderLogin.cookie,
    body: { phase: 'pickup' },
  });
  assert.equal(pickupCodeSent.response.status, 200);
  assert.equal(emails.at(-1).to, 'pickup@example.com');
  assert.equal(emails.at(-1).inlineImage.name, `package-${order.result.order.reference}.png`);
  assert.match(emails.at(-1).html, /<img[^>]+src="cid:package-photo"/);
  const pickupCode = emails.at(-1).text.match(/is (\d{6})/)[1];
  assert.match(emails.at(-1).html, new RegExp(`<strong[^>]*>${pickupCode}</strong>`));
  assert.equal(
    (await request(`/api/admin/orders/${order.result.order.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: { status: 'Delivered', riderId: registeredRider.result.rider.id },
    })).response.status,
    409,
  );
  const wrongPickupCode = await request(`/api/rider/orders/${order.result.order.id}/verify-code`, {
    method: 'POST',
    cookie: riderLogin.cookie,
    body: { phase: 'pickup', code: String((Number(pickupCode) + 1) % 1_000_000).padStart(6, '0') },
  });
  assert.equal(wrongPickupCode.response.status, 400);
  const pickupVerified = await request(`/api/rider/orders/${order.result.order.id}/verify-code`, {
    method: 'POST',
    cookie: riderLogin.cookie,
    body: { phase: 'pickup', code: pickupCode },
  });
  assert.equal(pickupVerified.response.status, 200);
  assert.equal(pickupVerified.result.order.status, 'Collected');
  const collectedNotice = emails.find(email => email.to === 'customer@example.com' && /collected/i.test(email.subject));
  assert.ok(collectedNotice);
  assert.equal(collectedNotice.inlineImage.name, `package-${order.result.order.reference}.png`);
  assert.equal(collectedNotice.inlineImage.contentType, 'image/png');
  assert.equal(collectedNotice.inlineImage.cid, 'package-photo');
  assert.deepEqual(
    Buffer.from(collectedNotice.inlineImage.content, 'base64').subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert.match(collectedNotice.text, /package photo is shown below/i);
  assert.match(collectedNotice.html, /<img[^>]+src="cid:package-photo"/);
  assert.match(collectedNotice.html, /alt="Package photo"/);
  const recipientPickupNotice = emails.find(email => email.to === 'delivery@example.com' && /on its way/i.test(email.subject));
  assert.ok(recipientPickupNotice);
  assert.match(recipientPickupNotice.text, /picked up a package addressed to you/i);
  assert.match(recipientPickupNotice.html, /alt="Package photo"/);
  assert.deepEqual(recipientPickupNotice.inlineImage, collectedNotice.inlineImage);
  failInTransitEmail = true;
  const deliveryCodeSent = await request(`/api/rider/orders/${order.result.order.id}/handoff-code`, {
    method: 'POST',
    cookie: riderLogin.cookie,
    body: { phase: 'delivery' },
  });
  failInTransitEmail = false;
  assert.equal(deliveryCodeSent.response.status, 200);
  assert.match(deliveryCodeSent.result.warning, /code was sent and saved/i);
  const deliveryCodeEmail = emails.findLast(email => email.to === 'delivery@example.com' && /delivery code/i.test(email.subject));
  assert.ok(deliveryCodeEmail);
  const deliveryCode = deliveryCodeEmail.text.match(/is (\d{6})/)[1];
  assert.ok(!emails.some(email => email.to === 'customer@example.com' && /on its way/i.test(email.subject)));
  failDeliveredEmail = true;
  const deliveryVerified = await request(`/api/rider/orders/${order.result.order.id}/verify-code`, {
    method: 'POST',
    cookie: riderLogin.cookie,
    body: { phase: 'delivery', code: deliveryCode },
  });
  failDeliveredEmail = false;
  assert.equal(deliveryVerified.response.status, 200);
  assert.equal(deliveryVerified.result.order.status, 'Delivered');
  assert.equal(deliveryVerified.result.order.pickupVerified, true);
  assert.equal(deliveryVerified.result.order.deliveryVerified, true);
  // Rider earnings should be computed as 1500 * ceil(2.4) = 4500 (per test configuration)
  assert.equal(deliveryVerified.result.order.riderEarnings, 1500 * Math.ceil(2.4));
  assert.match(deliveryVerified.result.warning, /status email could not be sent/i);
  assert.ok(!emails.some(email => email.to === 'customer@example.com' && /delivered/i.test(email.subject)));

  const sent = await request('/api/admin/notifications', {
    method: 'POST',
    cookie: adminCookie,
    body: { subject: 'Route update', message: 'Please check the route.', audience: 'everyone' },
  });
  assert.equal(sent.response.status, 201);
  const customerMessages = await request('/api/customer/notifications', { cookie: customer.cookie });
  const riderMessages = await request('/api/rider/notifications', { cookie: riderLogin.cookie });
  assert.equal(customerMessages.result.notifications[0].subject, 'Route update');
  assert.equal(riderMessages.result.notifications[0].subject, 'Route update');

  failNewOrderEmail = true;
  const savedDespiteEmailFailure = await request('/api/customer/orders', {
    method: 'POST',
    cookie: customer.cookie,
    body: {
      item: 'Another box',
      quantity: 1,
      description: 'Order email outage case',
      pickup: 'Three Street',
      delivery: 'Four Street',
      pickupEmail: 'pickup@example.com',
      deliveryEmail: 'delivery@example.com',
      date: '2026-10-20',
      phone: '555-0110',
      notes: '',
      photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    },
  });
  failNewOrderEmail = false;
  assert.equal(savedDespiteEmailFailure.response.status, 201);
  assert.match(savedDespiteEmailFailure.result.warning, /request was saved/i);
  const customerOrdersAfterNotificationFailure = await request('/api/customer/orders', { cookie: customer.cookie });
  assert.ok(customerOrdersAfterNotificationFailure.result.orders.some(
    savedOrder => savedOrder.id === savedDespiteEmailFailure.result.order.id,
  ));

  const riderLogout = await request('/api/auth/logout', {
    method: 'POST',
    cookie: combinedCookies,
    body: { role: 'rider' },
  });
  assert.equal(riderLogout.response.status, 204);
  const signedOutRider = await request('/api/rider/me', { cookie: riderLogin.cookie });
  assert.equal(signedOutRider.response.status, 200);
  assert.equal(signedOutRider.result.rider, null);
  assert.equal((await request('/api/auth/me', { cookie: combinedCookies })).response.status, 200);
  assert.equal((await request('/api/auth/admin/me', { cookie: combinedCookies })).response.status, 200);

  const photo = await fetch(`${baseUrl}/api/orders/${order.result.order.id}/photo`, {
    headers: { Cookie: customer.cookie },
  });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/png');
});
