require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const { createConfiguredDatabase } = require('./db');

const scrypt = promisify(crypto.scrypt);
const sessionCookies = {
  customer: 'ao_customer_session',
  rider: 'ao_rider_session',
  admin: 'ao_admin_session',
};
const sessionRoles = Object.keys(sessionCookies);
const legacySessionCookie = 'ao_session';
const sessionDuration = 7 * 24 * 60 * 60 * 1000;
const orderStatuses = ['Received', 'Confirmed', 'Collected', 'In transit', 'Delivered', 'Cancelled'];
const riderStatuses = ['Approved', 'Declined'];
const photoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const staticDirectory = __dirname;
const handoffCodeDuration = 10 * 60 * 1000;
const handoffCodeAttemptLimit = 5;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function brevoApiFailure(status, providerMessage = '') {
  const message = typeof providerMessage === 'string' ? providerMessage : '';
  if (status === 401 || status === 403) {
    if (/ip|allow.?list|authori[sz]ed address/i.test(message)) {
      return 'Brevo rejected this server IP. Add the Render outbound IP addresses to Brevo’s authorized-IP list, then redeploy or restart the Render service.';
    }
    return 'Brevo rejected the API key. Create a new transactional API key in Brevo, update BREVO_API_KEY in Render (not the SMTP key), then redeploy or restart the service. If Brevo uses IP restrictions, allow the Render outbound IPs too.';
  }
  return 'Brevo could not send the email. Please try again or contact the administrator.';
}

async function sendBrevoApiEmail({ to, subject, text, html, attachment, senderEmail, senderName }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw requestError('Email delivery is not configured. Set BREVO_API_KEY.', 503);
  }

  let result;
  try {
    result = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html,
        ...(attachment?.length ? { attachment } : {}),
      }),
    });
  } catch (error) {
    console.error('Brevo email request failed:', error);
    throw requestError('Brevo could not be reached to send the email. Please try again.', 502);
  }
  if (!result.ok) {
    const responseText = await result.text();
    let providerMessage = '';
    if (responseText) {
      try {
        providerMessage = JSON.parse(responseText).message || '';
      } catch {
        providerMessage = '';
      }
    }
    console.error(`Brevo email request failed with status ${result.status}${providerMessage ? `: ${providerMessage.slice(0, 240)}` : '.'}`);
    throw requestError(brevoApiFailure(result.status, providerMessage), 502);
  }
}

async function sendBrevoEmail({ to, subject, text, html, attachment, inlineImage }) {
  const senderEmail = normalizeEmail(process.env.BREVO_SENDER_EMAIL);
  if (!senderEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
    throw requestError('Email delivery is not configured. Set a valid BREVO_SENDER_EMAIL.', 503);
  }
  const senderName = process.env.BREVO_SENDER_NAME || 'A&M Logistics';
  const apiHtml = inlineImage
    ? html.replace(
      /<img src="cid:[^"]+" alt="Package photo"[^>]*>/,
      '<p style="color:#4d584f;font-family:Arial,sans-serif;font-size:14px;">The package photo is attached to this email.</p>',
    )
    : html;
  const apiText = inlineImage
    ? `${text}\n\nThe package photo is attached to this email.`
    : text;
  const apiAttachments = [
    ...(attachment || []),
    ...(inlineImage ? [{ name: inlineImage.name, content: inlineImage.content }] : []),
  ];

  await sendBrevoApiEmail({
    to,
    subject,
    text: apiText,
    html: apiHtml,
    attachment: apiAttachments,
    senderEmail,
    senderName,
  });
}

function emailContent(title, lines, { highlightedCode = '', photoCid = '' } = {}) {
  const safeTitle = escapeHtml(title);
  const safeLines = lines.map(line => {
    const codeIndex = highlightedCode ? line.indexOf(highlightedCode) : -1;
    let content = escapeHtml(line);
    if (codeIndex >= 0) {
      const before = escapeHtml(line.slice(0, codeIndex));
      const code = escapeHtml(highlightedCode);
      const after = escapeHtml(line.slice(codeIndex + highlightedCode.length));
      content = `${before}<strong style="display:inline-block;padding:3px 8px;border-radius:4px;background:#f0f5df;color:#405326;font-size:20px;letter-spacing:3px;">${code}</strong>${after}`;
    } else {
      const labelEnd = line.indexOf(':');
      if (labelEnd > 0 && labelEnd < 30) {
        content = `<strong style="color:#263b32;">${escapeHtml(line.slice(0, labelEnd + 1))}</strong>${escapeHtml(line.slice(labelEnd + 1))}`;
      }
    }
    return `<p style="margin:0 0 14px;color:#4d584f;font-family:Arial,sans-serif;font-size:15px;line-height:1.7;">${content}</p>`;
  }).join('');
  const photoMarkup = photoCid
    ? `<div style="margin:24px 0;padding:16px;border:1px solid #e7e9e2;background:#fafbf8;"><p style="margin:0 0 12px;color:#263b32;font-family:Arial,sans-serif;font-size:14px;font-weight:700;">Package photo</p><img src="cid:${escapeHtml(photoCid)}" alt="Package photo" width="500" style="display:block;width:100%;max-width:500px;height:auto;border:0;"></div>`
    : '';
  return {
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;padding:0;background:#f2f3ed;color:#202720;font-family:Arial,sans-serif;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(lines[0] || title)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f2f3ed;"><tr><td align="center" style="padding:32px 16px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #dfe2d9;"><tr><td style="padding:22px 30px;background:#263b32;color:#ffffff;"><p style="margin:0;font-size:20px;font-weight:700;letter-spacing:1px;">A&amp;M <span style="font-size:10px;letter-spacing:2px;color:#d2ee61;">LOGISTICS</span></p></td></tr><tr><td style="padding:34px 30px 24px;"><p style="margin:0 0 10px;color:#71843c;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">A CLEAR UPDATE FROM A&amp;M</p><h1 style="margin:0 0 22px;color:#202720;font-size:27px;line-height:1.25;">${safeTitle}</h1>${safeLines}${photoMarkup}</td></tr><tr><td style="padding:17px 30px;border-top:1px solid #e7e9e2;background:#fafbf8;"><p style="margin:0;color:#747b72;font-size:12px;line-height:1.6;">A&amp;M Logistics<br>Good things get there.</p></td></tr></table></td></tr></table></body></html>`,
    text: `A&M LOGISTICS\n\n${title}\n\n${lines.join('\n\n')}\n\nA&M Logistics — Good things get there.`,
  };
}

function orderPhotoAttachment(order) {
  if (!order.photo || !order.photo_type) return null;
  return {
    name: `package-${order.reference}.${({
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    })[order.photo_type] || 'img'}`,
    content: order.photo.toString('base64'),
    contentType: order.photo_type,
    cid: 'package-photo',
  };
}

function orderEmailContent(order, title, lines, { highlightedCode = '' } = {}) {
  const inlineImage = orderPhotoAttachment(order);
  const details = inlineImage ? [...lines, 'The package photo is shown below.'] : lines;
  return {
    ...emailContent(title, details, { highlightedCode, photoCid: inlineImage?.cid }),
    ...(inlineImage ? { inlineImage } : {}),
  };
}

function codeDigest(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function secureDigestMatches(first, second) {
  const firstBuffer = Buffer.from(first, 'hex');
  const secondBuffer = Buffer.from(second, 'hex');
  return firstBuffer.length === secondBuffer.length && crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function textField(body, field, { min = 1, max = 500 } = {}) {
  const value = typeof body[field] === 'string' ? body[field].trim() : '';
  if (value.length < min || value.length > max) {
    const error = new Error(`${field} must be between ${min} and ${max} characters.`);
    error.status = 400;
    throw error;
  }
  return value;
}

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cookieValue(request, name) {
  const cookieHeader = request.headers.cookie || '';
  const entry = cookieHeader.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sendSession(response, token, role) {
  const production = process.env.NODE_ENV === 'production';
  const attributes = production ? '; Secure; SameSite=None' : '; SameSite=Strict';
  response.setHeader('Set-Cookie', `${sessionCookies[role]}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${sessionDuration / 1000}${attributes}`);
}

function clearSessionCookie(response, name) {
  const production = process.env.NODE_ENV === 'production';
  const attributes = production ? '; Secure; SameSite=None' : '; SameSite=Strict';
  response.append('Set-Cookie', `${name}=; HttpOnly; Path=/; Max-Age=0${attributes}`);
}

// Compute rider earnings based on configured per-kilometre rate (NGN). Default is 1500 per started km.
function computeRiderEarnings(distanceKm) {
  const rate = Number(process.env.RIDER_RATE_PER_KM_NGN) || 1500;
  const km = Number(distanceKm) || 0;
  const startedKm = Math.max(0, Math.ceil(km));
  return rate * startedKm;
}

async function passwordDigest(password, salt = crypto.randomBytes(16)) {
  const digest = await scrypt(password, salt, 64);
  return { salt: salt.toString('hex'), hash: digest.toString('hex') };
}

async function passwordMatches(password, salt, expectedHash) {
  const actual = await scrypt(password, Buffer.from(salt, 'hex'), 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function createSession(database, response, role, principalId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + sessionDuration;
  await database.insert('sessions', {
    token_hash: hashToken(token),
    role,
    principal_id: principalId,
    expires_at: expiresAt,
  });
  sendSession(response, token, role);
}

function authenticate(database, role, { allowAnonymous = false } = {}) {
  return async (request, response, next) => {
    try {
    const cookieNames = role
      ? [sessionCookies[role], ...sessionRoles.filter(sessionRole => sessionRole !== role).map(sessionRole => sessionCookies[sessionRole]), legacySessionCookie]
      : [...Object.values(sessionCookies), legacySessionCookie];
    const credentials = cookieNames
      .map(name => ({ name, token: cookieValue(request, name) }))
      .filter(({ token }) => token);
    if (!credentials.length) {
      if (allowAnonymous) {
        request.auth = null;
        return next();
      }
      return response.status(401).json({ error: 'Please sign in to continue.' });
    }

    let roleMismatch = false;
    let expiredSession = false;
    for (const { name, token } of credentials) {
      const tokenHash = hashToken(token);
      const session = await database.find('sessions', record => record.token_hash === tokenHash);
      if (!session || session.expires_at <= Date.now()) {
        if (session) {
          await database.remove('sessions', record => record.token_hash === tokenHash);
          expiredSession = true;
        }
        clearSessionCookie(response, name);
        continue;
      }
      if (role && session.role !== role) {
        roleMismatch = true;
        continue;
      }
      request.auth = { role: session.role, principalId: session.principal_id };
      return next();
    }

    if (roleMismatch) {
      if (allowAnonymous) {
        request.auth = null;
        return next();
      }
      return response.status(403).json({ error: 'You do not have permission to access this page.' });
    }
    if (allowAnonymous) {
      request.auth = null;
      return next();
    }
    return response.status(401).json({
      error: expiredSession ? 'Your session has expired. Please sign in again.' : 'Please sign in to continue.',
    });
    } catch (error) {
      next(error);
    }
  };
}

function publicRider(rider) {
  return {
    id: rider.id,
    email: rider.email,
    name: rider.name,
    phone: rider.phone,
    vehicle: rider.vehicle,
    area: rider.area,
    status: rider.status,
    reference: rider.reference,
    registeredAt: rider.registered_at,
    reviewedAt: rider.reviewed_at,
  };
}

function adminRider(rider) {
  return { ...publicRider(rider), license: rider.license };
}

async function publicOrder(database, order) {
  const rider = order.rider_id
    ? await database.find('riders', record => record.id === order.rider_id)
    : null;
  const user = await database.find('users', record => record.id === order.user_id);
  return {
    id: order.id,
    reference: order.reference,
    email: user?.email || order.email,
    name: user?.name || order.name,
    item: order.item,
    quantity: order.quantity,
    description: order.description,
    pickup: order.pickup,
    delivery: order.delivery,
    pickupEmail: order.pickup_email || '',
    deliveryEmail: order.delivery_email || '',
    date: order.pickup_date,
    phone: order.phone,
    notes: order.notes,
    photoType: order.photo_type,
    status: order.status,
    pickupVerified: Boolean(order.pickup_verified_at),
    deliveryVerified: Boolean(order.delivery_verified_at),
    riderId: order.rider_id,
    riderName: rider?.name || '',
    riderEmail: rider?.email || '',
    // Optional: expose calculated/recorded delivery distance and rider earnings
    deliveryDistanceKm: order.delivery_distance_km ?? null,
    riderEarnings: order.rider_earnings_ngn ?? null,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    deliveredAt: order.delivered_at,
  };
}

async function orderStatusEmailTasks(database, order, status, sendEmail) {
  const customer = await database.find('users', user => user.id === order.user_id);
  if (!customer?.email) return [];
  const descriptions = {
    Confirmed: {
      title: 'Your delivery is confirmed',
      message: `Your delivery request ${order.reference} has been confirmed. We will keep you updated as it progresses.`,
    },
    Collected: {
      title: 'Your package has been collected',
      message: `Your package for delivery ${order.reference} has been collected and is being prepared for delivery.`,
    },
    'In transit': {
      title: 'Your package is on its way',
      message: `Your package for delivery ${order.reference} is now in transit.`,
    },
    Delivered: {
      title: 'Your package has been delivered',
      message: `Delivery ${order.reference} has been completed. Thank you for choosing A&M Logistics.`,
    },
    Cancelled: {
      title: 'Your delivery has been cancelled',
      message: `Delivery ${order.reference} has been cancelled. Please contact A&M Logistics if you have questions.`,
    },
  };
  const update = descriptions[status];
  if (!update) return [];
  const details = [
    `Hello ${customer.name || 'there'},`,
    update.message,
    `Item: ${order.quantity} × ${order.item}`,
    `Pickup: ${order.pickup}`,
    `Delivery: ${order.delivery}`,
  ];
  const orderContent = orderEmailContent(order, update.title, details);
  const tasks = [sendEmail({
    to: customer.email,
    subject: `${update.title} · ${order.reference}`,
    ...orderContent,
  })];
  if (status === 'Collected' && order.delivery_email) {
    const recipientTitle = 'Your package is on its way';
    tasks.push(sendEmail({
      to: order.delivery_email,
      subject: `${recipientTitle} · ${order.reference}`,
      ...orderEmailContent(order, recipientTitle, [
        'A&M Logistics has picked up a package addressed to you.',
        `Delivery reference: ${order.reference}`,
        `Item: ${order.quantity} × ${order.item}`,
        `Delivery address: ${order.delivery}`,
        'The package is being prepared for delivery. We will share another update when its status changes.',
      ]),
    }));
  }
  return tasks;
}

async function sendNotifications(tasks, context) {
  const results = await Promise.allSettled(tasks);
  const failures = results.filter(result => result.status === 'rejected');
  failures.forEach(result => console.error(`${context} email notification failed:`, result.reason));
  return failures.length > 0;
}

function parsePhoto(dataUrl) {
  if (typeof dataUrl !== 'string') throw requestError('Add a JPG, PNG, or WebP photo under 5 MB.');
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || !photoTypes.has(match[1])) throw requestError('Add a valid JPG, PNG, or WebP photo.');
  const photo = Buffer.from(match[2], 'base64');
  if (!photo.length || photo.length > 5 * 1024 * 1024) throw requestError('The photo must be smaller than 5 MB.');
  const signatures = {
    'image/jpeg': photo.length >= 3 && photo[0] === 0xff && photo[1] === 0xd8 && photo[2] === 0xff,
    'image/png': photo.length >= 8 && photo.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/webp': photo.length >= 12 && photo.toString('ascii', 0, 4) === 'RIFF' && photo.toString('ascii', 8, 12) === 'WEBP',
  };
  if (!signatures[match[1]]) throw requestError('The uploaded photo does not match its image type.');
  return { photo, type: match[1] };
}

function createApp(database, { sendEmail = sendBrevoEmail } = {}) {
  const app = express();
  const requireCustomer = authenticate(database, 'customer');
  const optionalCustomer = authenticate(database, 'customer', { allowAnonymous: true });
  const requireRider = authenticate(database, 'rider');
  const optionalRider = authenticate(database, 'rider', { allowAnonymous: true });
  const requireAdmin = authenticate(database, 'admin');
  const optionalAdmin = authenticate(database, 'admin', { allowAnonymous: true });
  const requireAdminRole = authenticate(database, null);
  const adminEmails = async () => {
    const registeredEmails = (await database.list('users', user => user.role === 'admin')).map(admin => admin.email);
    const configuredEmail = normalizeEmail(process.env.ADMIN_EMAIL);
    return [...new Set([...registeredEmails, configuredEmail].filter(Boolean))];
  };
  const allowedOrigins = new Set([
    'https://mar47362626-eng.github.io',
    ...(process.env.ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean),
  ].map(origin => new URL(origin).origin));
  const isAllowedOrigin = (origin, request) => {
    try {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      if (allowedOrigins.has(parsed.origin)) return true;

      const requestHost = request.get('host')?.toLowerCase();
      const sameHost = requestHost && parsed.host.toLowerCase() === requestHost;
      if (sameHost && (process.env.NODE_ENV !== 'production' || parsed.protocol === 'https:')) return true;

      return process.env.NODE_ENV !== 'production'
        && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    } catch {
      return false;
    }
  };

  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb', strict: true }));
  app.use((request, response, next) => {
    const origin = request.get('origin');
    if (origin && !isAllowedOrigin(origin, request)) {
      return response.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Vary', 'Origin');
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        response.setHeader('Access-Control-Max-Age', '600');
        return response.status(204).end();
      }
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.get('/api/health', (request, response) => response.json({ status: 'ok' }));

  app.get('/favicon.ico', (request, response) => response.redirect(302, '/favicon.svg'));

  app.get(['/admin/', '/rider/'], (request, response) => {
    if (request.path.endsWith('/')) {
      return response.redirect(301, request.path.slice(0, -1));
    }
    return response.sendFile(path.join(staticDirectory, request.path === '/admin' ? 'admin.html' : 'rider.html'));
  });
  app.get(['/admin.html', '/rider.html'], (request, response) => {
    response.redirect(301, request.path === '/admin.html' ? '/admin' : '/rider');
  });

  app.post('/api/auth/register', async (request, response, next) => {
    try {
      const name = textField(request.body, 'name', { max: 120 });
      const phone = textField(request.body, 'phone', { max: 40 });
      const email = normalizeEmail(request.body.email);
      const password = request.body.password;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw requestError('Enter a valid email address.');
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        throw requestError('Password must be between 8 and 128 characters.');
      }
      if (await database.find('users', user => user.email.toLowerCase() === email)) {
        throw requestError('An account with this email already exists. Please log in instead.', 409);
      }
      const credentials = await passwordDigest(password);
      const id = crypto.randomUUID();
      const registeredAt = Date.now();
      await database.insert('users', {
        id, email, name, phone,
        password_salt: credentials.salt,
        password_hash: credentials.hash,
        role: 'customer',
        registered_at: registeredAt,
      });
      let notificationWarning = false;
      try {
        const content = emailContent('Welcome to A&M Logistics', [
          `Hello ${name}, your customer account has been created.`,
          'You can now sign in and manage your delivery requests.',
        ]);
        await sendEmail({ to: email, subject: 'Welcome to A&M Logistics', ...content });
      } catch (error) {
        console.error('Customer welcome email notification failed:', error);
        notificationWarning = true;
      }
      await createSession(database, response, 'customer', id);
      response.status(201).json({
        user: { id, email, name, phone, registeredAt },
        ...(notificationWarning ? { warning: 'Your account was created, but the welcome email could not be sent.' } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/admin/register', optionalAdmin, async (request, response, next) => {
    try {
      const isAuthenticatedAdmin = request.auth?.role === 'admin';
      if (await database.find('users', user => user.role === 'admin') && !isAuthenticatedAdmin) {
        throw requestError('An existing admin must sign in before another admin account can be registered.', 403);
      }
      const name = textField(request.body, 'name', { max: 120 });
      const phone = typeof request.body.phone === 'string' ? request.body.phone.trim() : '';
      if (phone.length > 40) throw requestError('Phone number must be 40 characters or fewer.');
      const email = normalizeEmail(request.body.email);
      const password = request.body.password;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw requestError('Enter a valid email address.');
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        throw requestError('Password must be between 8 and 128 characters.');
      }
      if (await database.find('users', user => user.email.toLowerCase() === email)) {
        throw requestError('An admin with this email already exists. Please log in instead.', 409);
      }
      const credentials = await passwordDigest(password);
      if (!isAuthenticatedAdmin && await database.find('users', user => user.role === 'admin')) {
        throw requestError('An admin account was registered while this request was in progress. Please sign in.', 403);
      }
      const id = crypto.randomUUID();
      const registeredAt = Date.now();
      await database.insert('users', {
        id,
        email,
        name,
        phone,
        password_salt: credentials.salt,
        password_hash: credentials.hash,
        role: 'admin',
        registered_at: registeredAt,
      });
      try {
        const content = emailContent('Your A&M administrator account is ready', [
          `Hello ${name}, your administrator account has been created.`,
        ]);
        await sendEmail({ to: email, subject: 'Your A&M administrator account is ready', ...content });
      } catch (error) {
        await database.remove('users', user => user.id === id);
        throw error;
      }
      await createSession(database, response, 'admin', id);
      response.status(201).json({ user: { id, email, name, phone, registeredAt } });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/login', async (request, response, next) => {
    try {
      const email = normalizeEmail(request.body.email);
      const password = request.body.password;
      const account = await database.find('users', user => user.email.toLowerCase() === email && user.role === 'customer');
      if (!account || typeof password !== 'string' || password.length < 8 || password.length > 128
        || !(await passwordMatches(password, account.password_salt, account.password_hash))) {
        throw requestError('We could not find an account with those details. Check them or create an account.', 401);
      }
      await createSession(database, response, 'customer', account.id);
      response.json({ user: { id: account.id, email: account.email, name: account.name, phone: account.phone, registeredAt: account.registered_at } });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/admin/login', async (request, response, next) => {
    try {
      const email = normalizeEmail(request.body.email);
      const password = request.body.password;
      const account = await database.find('users', user => user.email.toLowerCase() === email && user.role === 'admin');
      if (!account || typeof password !== 'string' || password.length < 8 || password.length > 128
        || !(await passwordMatches(password, account.password_salt, account.password_hash))) {
        throw requestError('Admin email or password is incorrect.', 401);
      }
      await createSession(database, response, 'admin', account.id);
      response.json({ user: { email: account.email, name: account.name } });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/auth/me', optionalCustomer, async (request, response) => {
    if (!request.auth) return response.json({ user: null });
    const account = await database.find('users', user => user.id === request.auth.principalId);
    if (!account) return response.json({ user: null });
    response.json({ user: { id: account.id, email: account.email, name: account.name, phone: account.phone, registeredAt: account.registered_at } });
  });

  app.get('/api/auth/admin/me', requireAdmin, async (request, response) => {
    const admin = await database.find('users', user => user.id === request.auth.principalId);
    if (!admin) return response.status(401).json({ error: 'Admin account not found.' });
    response.json({ user: admin });
  });

  app.post('/api/auth/logout', async (request, response) => {
    const role = request.body?.role;
    if (role && !sessionRoles.includes(role)) throw requestError('Choose a valid account type to sign out.', 400);
    const cookieNames = role ? [sessionCookies[role], legacySessionCookie] : Object.values(sessionCookies).concat(legacySessionCookie);
    for (const name of cookieNames) {
      const token = cookieValue(request, name);
      if (!token) continue;
      const tokenHash = hashToken(token);
      const session = await database.find('sessions', record => record.token_hash === tokenHash);
      if (!role || !session || session.role === role) {
        await database.remove('sessions', record => record.token_hash === tokenHash);
        clearSessionCookie(response, name);
      }
    }
    response.status(204).end();
  });

  app.post('/api/rider/applications', async (request, response, next) => {
    try {
      const name = textField(request.body, 'name', { max: 120 });
      const phone = textField(request.body, 'phone', { max: 40 });
      const vehicle = textField(request.body, 'vehicle', { max: 40 });
      const license = textField(request.body, 'license', { max: 100 });
      const area = textField(request.body, 'area', { max: 160 });
      const email = normalizeEmail(request.body.email);
      const password = request.body.password;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw requestError('Enter a valid email address.');
      if (!['Bicycle', 'Motorcycle', 'Car', 'Van', 'Other'].includes(vehicle)) throw requestError('Choose a valid vehicle type.');
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        throw requestError('Password must be between 8 and 128 characters.');
      }
      if (await database.find('riders', rider => rider.email.toLowerCase() === email)) {
        throw requestError('A rider application already exists for this email. Log in to check its status.', 409);
      }
      const credentials = await passwordDigest(password);
      const id = crypto.randomUUID();
      const reference = `R-${Date.now().toString(36).toUpperCase()}`;
      const registeredAt = Date.now();
      await database.insert('riders', {
        id, email, name, phone, vehicle, license, area,
        password_salt: credentials.salt,
        password_hash: credentials.hash,
        status: 'Pending review',
        reference,
        registered_at: registeredAt,
        reviewed_at: null,
      });
      let notificationWarning = false;
      try {
        const content = emailContent('Rider application received', [
          `Hello ${name}, we have received your rider application.`,
          `Application reference: ${reference}. We will email you when it has been reviewed.`,
        ]);
        await sendEmail({ to: email, subject: 'Rider application received', ...content });
      } catch (error) {
        console.error('Rider application email notification failed:', error);
        notificationWarning = true;
      }
      await createSession(database, response, 'rider', id);
      response.status(201).json({
        rider: publicRider(await database.find('riders', rider => rider.id === id)),
        ...(notificationWarning ? { warning: 'Your application was saved, but the confirmation email could not be sent.' } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/rider/login', async (request, response, next) => {
    try {
      const email = normalizeEmail(request.body.email);
      const password = request.body.password;
      const rider = await database.find('riders', record => record.email.toLowerCase() === email);
      if (!rider || typeof password !== 'string' || password.length < 8 || password.length > 128
        || !(await passwordMatches(password, rider.password_salt, rider.password_hash))) {
        throw requestError('We could not find a rider application with those details.', 401);
      }
      await createSession(database, response, 'rider', rider.id);
      response.json({ rider: publicRider(rider) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/rider/me', optionalRider, async (request, response) => {
    if (!request.auth) return response.json({ rider: null });
    const rider = await database.find('riders', record => record.id === request.auth.principalId);
    if (!rider) return response.status(401).json({ error: 'Rider application not found.' });
    response.json({ rider: publicRider(rider) });
  });

  app.get('/api/rider/deliveries', requireRider, async (request, response) => {
    const rider = await database.find('riders', record => record.id === request.auth.principalId);
    if (!rider || rider.status !== 'Approved') throw requestError('Your rider account is not approved.', 403);
    const orders = (await database.list('orders', order => order.rider_id === request.auth.principalId))
      .sort((first, second) => second.created_at - first.created_at)
      .map(order => publicOrder(database, order));
    const publicOrders = await Promise.all(orders);
    response.json({ orders: publicOrders });
  });

  app.get('/api/rider/notifications', requireRider, async (request, response) => {
    const email = (await database.find('riders', rider => rider.id === request.auth.principalId))?.email || '';
    const messages = (await database.list('notifications', notification => notification.recipients?.includes(email.toLowerCase())))
      .sort((first, second) => second.created_at - first.created_at)
      .map(({ recipients, ...notification }) => notification);
    response.json({ notifications: messages });
  });

  app.get('/api/customer/orders', requireCustomer, async (request, response) => {
    const orders = (await database.list('orders', order => order.user_id === request.auth.principalId))
      .sort((first, second) => second.created_at - first.created_at)
      .map(order => publicOrder(database, order));
    response.json({ orders: await Promise.all(orders) });
  });

  app.post('/api/customer/orders', requireCustomer, async (request, response, next) => {
    try {
      const item = textField(request.body, 'item', { max: 160 });
      const quantity = Number(request.body.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw requestError('Quantity must be between 1 and 100.');
      const description = textField(request.body, 'description', { max: 1200 });
      const pickup = textField(request.body, 'pickup', { max: 500 });
      const delivery = textField(request.body, 'delivery', { max: 500 });
      const pickupEmail = normalizeEmail(request.body.pickupEmail);
      const deliveryEmail = normalizeEmail(request.body.deliveryEmail);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pickupEmail)
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(deliveryEmail)) {
        throw requestError('Enter valid email addresses for both pickup and delivery contacts.');
      }
      const pickupDate = textField(request.body, 'date', { max: 10 });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)
        || Number.isNaN(Date.parse(`${pickupDate}T00:00:00Z`))
        || new Date(`${pickupDate}T00:00:00Z`).toISOString().slice(0, 10) !== pickupDate) {
        throw requestError('Choose a valid pickup date.');
      }
      const phone = textField(request.body, 'phone', { max: 40 });
      const notes = textField(request.body, 'notes', { min: 0, max: 1200 });
      const { photo, type } = parsePhoto(request.body.photo);
      const id = crypto.randomUUID();
      const reference = `AO-${new Date().toISOString().slice(2, 10).replaceAll('-', '')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      const createdAt = Date.now();
      // Optional client-provided estimate distance (in kilometres) — stored if present.
      const deliveryDistanceKm = typeof request.body.deliveryDistanceKm === 'number' && Number.isFinite(request.body.deliveryDistanceKm)
        ? Number(request.body.deliveryDistanceKm)
        : null;

      const order = await database.insert('orders', {
        id,
        reference,
        user_id: request.auth.principalId,
        item,
        quantity,
        description,
        pickup,
        delivery,
        pickup_email: pickupEmail,
        delivery_email: deliveryEmail,
        pickup_date: pickupDate,
        phone,
        notes,
        photo,
        photo_type: type,
        status: 'Received',
        rider_id: null,
        created_at: createdAt,
        updated_at: null,
        delivered_at: null,
        pickup_verified_at: null,
        delivery_verified_at: null,
        pickup_code_hash: null,
        pickup_code_expires_at: null,
        pickup_code_attempts: 0,
        delivery_code_hash: null,
        delivery_code_expires_at: null,
        delivery_code_attempts: 0,
        // New fields for estimated distance (km) and rider earnings — earnings calculated when delivery is completed.
        delivery_distance_km: deliveryDistanceKm,
        rider_earnings_ngn: null,
      });
      const customer = await database.find('users', user => user.id === request.auth.principalId);
      const adminRecipients = await adminEmails();
      const details = [
        `Delivery request ${reference} was received.`,
        `Customer: ${customer?.name || customer?.email || 'Customer'} (${customer?.email || ''})`,
        `Item: ${quantity} × ${item}`,
        `Pickup: ${pickup}`,
        `Delivery: ${delivery}`,
      ];
      const notificationWarning = await sendNotifications([
        sendEmail({
          to: customer.email,
          subject: `Delivery request ${reference} received`,
          ...orderEmailContent(
            order,
            'Your delivery request is in',
            details.slice(0, 1).concat(`Pickup: ${pickup}`, `Delivery: ${delivery}`),
          ),
        }),
        ...adminRecipients.map(email => sendEmail({
          to: email,
          subject: `New delivery request ${reference}`,
          ...orderEmailContent(order, 'New delivery request', details),
        })),
      ], 'New delivery request');
      response.status(201).json({
        order: await publicOrder(database, order),
        ...(notificationWarning ? { warning: 'Your request was saved, but one or more order emails could not be sent.' } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/customer/notifications', requireCustomer, async (request, response) => {
    const email = (await database.find('users', user => user.id === request.auth.principalId))?.email || '';
    const notifications = (await database.list('notifications', notification => notification.recipients?.includes(email.toLowerCase())))
      .sort((first, second) => second.created_at - first.created_at)
      .map(({ recipients, ...notification }) => notification);
    response.json({ notifications });
  });

  app.get('/api/orders/:id/photo', requireAdminRole, async (request, response) => {
    const order = await database.find('orders', record => record.id === request.params.id);
    if (!order) return response.status(404).json({ error: 'Order not found.' });
    const isOwner = request.auth.role === 'customer' && order.user_id === request.auth.principalId;
    const isAssignedRider = request.auth.role === 'rider' && order.rider_id === request.auth.principalId;
    if (request.auth.role !== 'admin' && !isOwner && !isAssignedRider) {
      return response.status(403).json({ error: 'You do not have permission to view this photo.' });
    }
    response.setHeader('Content-Type', order.photo_type);
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(order.photo);
  });

  app.get('/api/admin/orders', requireAdmin, async (request, response) => {
    const orders = (await database.list('orders'))
      .sort((first, second) => second.created_at - first.created_at)
      .map(order => publicOrder(database, order));
    response.json({ orders: await Promise.all(orders) });
  });

  app.get('/api/admin/users', requireAdmin, async (request, response) => {
    const users = (await database.list('users', user => user.role === 'customer'))
      .sort((first, second) => second.registered_at - first.registered_at)
      .map(({ id, email, name, phone, registered_at }) => ({ id, email, name, phone, registeredAt: registered_at }));
    response.json({ users });
  });

  app.get('/api/admin/riders', requireAdmin, async (request, response) => {
    const riders = (await database.list('riders'))
      .sort((first, second) => second.registered_at - first.registered_at)
      .map(adminRider);
    response.json({ riders });
  });

  app.get('/api/admin/registrations', requireAdmin, async (request, response) => {
    const users = await database.list('users', user => user.role === 'customer');
    const riders = await database.list('riders');
    const registrations = [
      ...users.map(user => ({
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        type: 'Customer',
        status: 'Registered',
        vehicle: null,
        area: null,
        license: null,
        registeredAt: user.registered_at,
      })),
      ...riders.map(rider => ({
        id: rider.id,
        name: rider.name,
        email: rider.email,
        phone: rider.phone,
        type: 'Rider',
        status: rider.status,
        vehicle: rider.vehicle,
        area: rider.area,
        license: rider.license,
        registeredAt: rider.registered_at,
      })),
    ].sort((first, second) => second.registeredAt - first.registeredAt).slice(0, 100);
    response.json({ registrations });
  });

  app.patch('/api/admin/riders/:id/status', requireAdmin, async (request, response, next) => {
    try {
      const status = request.body.status;
      if (!riderStatuses.includes(status)) throw requestError('Choose Approved or Declined.');
      const existingRider = await database.find('riders', record => record.id === request.params.id);
      if (!existingRider) throw requestError('Rider application not found.', 404);
      const reviewedAt = Date.now();
      const rider = await database.update('riders', record => record.id === request.params.id, record => ({
        ...record,
        status,
        reviewed_at: reviewedAt,
      }));
      if (status === 'Approved' && existingRider.status !== 'Approved') {
        const content = emailContent('Your rider application is approved', [
          `Hello ${rider.name}, your A&M Logistics rider application has been approved.`,
          'Sign in to your rider account to view assigned deliveries.',
        ]);
        try {
          await sendEmail({ to: rider.email, subject: 'Your rider application is approved', ...content });
        } catch (error) {
          await database.update('riders', record => record.id === rider.id, record => ({
            ...record,
            status: existingRider.status,
            reviewed_at: existingRider.reviewed_at,
          }));
          throw error;
        }
      }
      response.json({ rider: publicRider(rider) });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/admin/orders/:id', requireAdmin, async (request, response, next) => {
    try {
      const order = await database.find('orders', record => record.id === request.params.id);
      if (!order) throw requestError('Order not found.', 404);
      const status = request.body.status;
      if (!orderStatuses.includes(status)) throw requestError('Choose a valid delivery status.');
      let riderId = order.rider_id;
      if (Object.hasOwn(request.body, 'riderId')) {
        riderId = request.body.riderId || null;
        if (riderId) {
          const rider = await database.find('riders', record => record.id === riderId && record.status === 'Approved');
          if (!rider) throw requestError('Choose an approved rider.');
        }
      }
      if (status === 'Confirmed' && !riderId) {
        throw requestError('Assign an approved rider before confirming this delivery.');
      }
      if (status === 'Collected' && !order.pickup_verified_at) {
        throw requestError('Only the assigned rider can mark a pickup collected after verifying its code.', 409);
      }
      if (status === 'In transit' && !order.pickup_verified_at) {
        throw requestError('The pickup contact must verify the collection code before the delivery can be in transit.', 409);
      }
      if (status === 'Delivered' && !order.delivery_verified_at) {
        throw requestError('Only the assigned rider can complete delivery after verifying its code.', 409);
      }
      const updatedAt = Date.now();
      const deliveredAt = status === 'Delivered' ? order.delivered_at || updatedAt : null;
      const statusChanged = status !== order.status;
      let updatedOrder = await database.update('orders', record => record.id === request.params.id, record => ({
        ...record,
        status,
        rider_id: riderId,
        updated_at: updatedAt,
        delivered_at: deliveredAt,
      }));

      // If the order is now delivered, compute and save rider earnings if not already recorded.
      if (status === 'Delivered' && updatedOrder.rider_id && (updatedOrder.rider_earnings_ngn === null || updatedOrder.rider_earnings_ngn === undefined)) {
        const earnings = computeRiderEarnings(updatedOrder.delivery_distance_km);
        updatedOrder = await database.update('orders', record => record.id === request.params.id, record => ({
          ...record,
          rider_earnings_ngn: earnings,
        }));
      }

      const assignmentConfirmed = status === 'Confirmed'
        && riderId
        && (order.status !== 'Confirmed' || riderId !== order.rider_id);
      const emailTasks = statusChanged ? await orderStatusEmailTasks(database, updatedOrder, status, sendEmail) : [];
      if (assignmentConfirmed) {
        const rider = await database.find('riders', record => record.id === riderId);
        const content = orderEmailContent(order, 'A delivery has been assigned to you', [
          `Hello ${rider.name}, delivery ${order.reference} has been confirmed and assigned to you.`,
          `Pickup: ${order.pickup}`,
          `Delivery: ${order.delivery}`,
          `Pickup date: ${order.pickup_date}`,
          'Sign in to your rider account to view the delivery and request the pickup verification code.',
        ]);
        emailTasks.push(sendEmail({
          to: rider.email,
          subject: `Delivery ${order.reference} assigned to you`,
          ...content,
        }));
      }
      const notificationWarning = await sendNotifications(emailTasks, 'Order status');
      response.json({
        order: await publicOrder(database, updatedOrder),
        ...(notificationWarning ? { warning: 'The order was saved, but one or more email notifications could not be sent.' } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/rider/orders/:id/handoff-code', requireRider, async (request, response, next) => {
    try {
      const rider = await database.find('riders', record => record.id === request.auth.principalId);
      if (!rider || rider.status !== 'Approved') throw requestError('Your rider account is not approved.', 403);
      const order = await database.find('orders', record => record.id === request.params.id && record.rider_id === rider.id);
      if (!order) throw requestError('Assigned delivery not found.', 404);
      const phase = request.body.phase;
      if (phase !== 'pickup' && phase !== 'delivery') throw requestError('Choose pickup or delivery verification.');
      const isPickup = phase === 'pickup';
      if (isPickup && (order.status !== 'Confirmed' || order.pickup_verified_at)) {
        throw requestError('Pickup verification is only available for a confirmed, uncollected delivery.', 409);
      }
      if (!isPickup && (!order.pickup_verified_at
        || !['Collected', 'In transit'].includes(order.status)
        || order.delivery_verified_at)) {
        throw requestError('Delivery verification is available after the pickup has been verified.', 409);
      }
      const recipient = isPickup ? order.pickup_email : order.delivery_email;
      if (!recipient) throw requestError(`This order has no ${phase} contact email. Ask the customer to update the order.`, 409);
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      const stageLabel = isPickup ? 'pickup' : 'delivery';
      const content = orderEmailContent(order, `Your ${stageLabel} verification code`, [
        `Your A&M Logistics code for delivery ${order.reference} is ${code}.`,
        'Share this code only with the assigned rider at the handoff.',
        'This code expires in 10 minutes.',
      ], { highlightedCode: code });
      await sendEmail({
        to: recipient,
        subject: `A&M Logistics ${stageLabel} code for ${order.reference}`,
        ...content,
      });
      const statusChanged = !isPickup && order.status !== 'In transit';
      const issuedAt = Date.now();
      await database.update('orders', record => record.id === order.id, record => ({
        ...record,
        ...(isPickup ? {
          pickup_code_hash: codeDigest(code),
          pickup_code_expires_at: issuedAt + handoffCodeDuration,
          pickup_code_attempts: 0,
        } : {
          delivery_code_hash: codeDigest(code),
          delivery_code_expires_at: issuedAt + handoffCodeDuration,
          delivery_code_attempts: 0,
        }),
        ...(isPickup ? {} : { status: 'In transit', updated_at: issuedAt }),
      }));
      const notificationWarning = statusChanged
        && await sendNotifications(await orderStatusEmailTasks(database, order, 'In transit', sendEmail), 'In-transit status');
      response.json({
        message: `A verification code was emailed to the ${stageLabel} contact.`,
        ...(notificationWarning ? { warning: 'The code was sent and saved, but the package status email could not be sent.' } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/rider/orders/:id/verify-code', requireRider, async (request, response, next) => {
    try {
      const rider = await database.find('riders', record => record.id === request.auth.principalId);
      if (!rider || rider.status !== 'Approved') throw requestError('Your rider account is not approved.', 403);
      const order = await database.find('orders', record => record.id === request.params.id && record.rider_id === rider.id);
      if (!order) throw requestError('Assigned delivery not found.', 404);
      const phase = request.body.phase;
      if (phase !== 'pickup' && phase !== 'delivery') throw requestError('Choose pickup or delivery verification.');
      const isPickup = phase === 'pickup';
      if (isPickup && (order.status !== 'Confirmed' || order.pickup_verified_at)) {
        throw requestError('Pickup verification is not available for this delivery.', 409);
      }
      if (!isPickup && (!order.pickup_verified_at
        || order.status !== 'In transit'
        || order.delivery_verified_at)) {
        throw requestError('Delivery verification is not available for this delivery.', 409);
      }
      const hashField = isPickup ? 'pickup_code_hash' : 'delivery_code_hash';
      const expiryField = isPickup ? 'pickup_code_expires_at' : 'delivery_code_expires_at';
      const attemptsField = isPickup ? 'pickup_code_attempts' : 'delivery_code_attempts';
      if (!order[hashField] || !order[expiryField] || order[expiryField] <= Date.now()) {
        throw requestError('The verification code is missing or expired. Request a new one.', 410);
      }
      if (order[attemptsField] >= handoffCodeAttemptLimit) {
        throw requestError('Too many incorrect attempts. Request a new verification code.', 429);
      }
      const code = typeof request.body.code === 'string' ? request.body.code.trim() : '';
      if (!/^\d{6}$/.test(code) || !secureDigestMatches(codeDigest(code), order[hashField])) {
        await database.update('orders', record => record.id === order.id, record => ({
          ...record,
          [attemptsField]: (record[attemptsField] || 0) + 1,
        }));
        throw requestError('That verification code is incorrect.', 400);
      }
      const verifiedAt = Date.now();
      const newStatus = isPickup ? 'Collected' : 'Delivered';
      let updatedOrder = await database.update('orders', record => record.id === order.id, record => ({
        ...record,
        status: newStatus,
        updated_at: verifiedAt,
        delivered_at: isPickup ? record.delivered_at : verifiedAt,
        [isPickup ? 'pickup_verified_at' : 'delivery_verified_at']: verifiedAt,
        [hashField]: null,
        [expiryField]: null,
        [attemptsField]: 0,
      }));

      // On final delivery, compute and save rider earnings if available and not already set.
      if (!isPickup && updatedOrder.rider_id && (updatedOrder.rider_earnings_ngn === null || updatedOrder.rider_earnings_ngn === undefined)) {
        const earnings = computeRiderEarnings(updatedOrder.delivery_distance_km);
        updatedOrder = await database.update('orders', record => record.id === order.id, record => ({
          ...record,
          rider_earnings_ngn: earnings,
        }));
      }

      const notificationWarning = await sendNotifications(
        await orderStatusEmailTasks(database, updatedOrder, newStatus, sendEmail),
        'Verified handoff status',
      );
      response.json({
        order: await publicOrder(database, updatedOrder),
        ...(notificationWarning ? { warning: 'Code accepted and delivery status updated, but the status email could not be sent.' } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/notifications', requireAdmin, async (request, response) => {
    const notifications = (await database.list('notifications'))
      .sort((first, second) => second.created_at - first.created_at)
      .map(({ recipients, ...notification }) => notification);
    response.json({ notifications });
  });

  app.post('/api/admin/notifications', requireAdmin, async (request, response, next) => {
    try {
      const subject = textField(request.body, 'subject', { max: 100 });
      const message = textField(request.body, 'message', { max: 1200 });
      const audience = request.body.audience;
      if (!['everyone', 'customers', 'riders'].includes(audience)) throw requestError('Choose a valid notification audience.');

      const customers = audience === 'riders'
        ? []
        : await database.list('users', user => user.role === 'customer');
      const riders = audience === 'customers' ? [] : await database.list('riders');
      const recipients = audience === 'customers'
        ? customers.map(user => user.email)
        : audience === 'riders'
          ? riders.map(rider => rider.email)
          : [
            ...customers,
            ...riders,
          ].map(account => account.email);
      const uniqueRecipients = [...new Set(recipients.map(normalizeEmail))];
      if (!uniqueRecipients.length) throw requestError('There are no registered recipients for this audience yet.', 409);

      const labels = { everyone: 'Everyone', customers: 'Users', riders: 'Riders' };
      const id = crypto.randomUUID();
      const createdAt = Date.now();
      await database.insert('notifications', {
        id,
        subject,
        message,
        audience,
        audience_label: labels[audience],
        recipient_count: uniqueRecipients.length,
        created_at: createdAt,
        recipients: uniqueRecipients,
      });
      response.status(201).json({
        notification: { id, subject, message, audience, audienceLabel: labels[audience], recipientCount: uniqueRecipients.length, createdAt },
      });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', (request, response) => response.status(404).json({ error: 'API endpoint not found.' }));
  app.use((request, response, next) => {
    const staticPath = path.posix.normalize(`/${decodeURIComponent(request.path).toLowerCase()}`);
    if (/^\/(?:data|node_modules)(?:\/|$)/.test(staticPath)) {
      return response.status(404).type('text').send('Not found');
    }
    next();
  });
  app.use(express.static(staticDirectory, { index: 'index.html', dotfiles: 'deny' }));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error.type === 'entity.too.large') {
      return response.status(413).json({ error: 'The request is too large. Photos must be 5 MB or smaller.' });
    }
    if (error instanceof SyntaxError && 'body' in error) {
      return response.status(400).json({ error: 'Request body must contain valid JSON.' });
    }
    if (error.code === 'JSON_CONSTRAINT_UNIQUE' || error.code === '23505' || error.status === 409) {
      return response.status(409).json({ error: 'An account or application already exists for this email.' });
    }
    if (error.status) return response.status(error.status).json({ error: error.message });
    console.error(error);
    return response.status(500).json({ error: 'The server could not complete your request. Please try again.' });
  });

  return app;
}

async function seedAdmin(database) {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD;
  const hasConfiguredAdmin = Boolean(email || password);
  if (!hasConfiguredAdmin) return;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Set a valid ADMIN_EMAIL environment variable before starting the server.');
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new Error('Set an ADMIN_PASSWORD of 12 to 128 characters before starting the server.');
  }
  const credentials = await passwordDigest(password);
  const id = crypto.randomUUID();
  const admin = await database.find('users', user => user.email.toLowerCase() === email && user.role === 'admin');
  const record = {
    id: admin?.id || id,
    email,
    name: 'A&M Administrator',
    phone: '',
    password_salt: credentials.salt,
    password_hash: credentials.hash,
    role: 'admin',
    registered_at: admin?.registered_at || Date.now(),
  };
  if (admin) {
    await database.update('users', user => user.id === admin.id, () => record);
  } else {
    await database.insert('users', record);
  }
}

async function start() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const database = createConfiguredDatabase();
  await database.initialize?.();
  await seedAdmin(database);
  const app = createApp(database);
  app.listen(port, () => console.log(`A&M Logistics is running at http://localhost:${port}`));
}

if (require.main === module) {
  start().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { brevoApiFailure, createApp, passwordDigest, passwordMatches, seedAdmin, sendBrevoEmail };
