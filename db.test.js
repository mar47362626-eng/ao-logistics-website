const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createConfiguredDatabase, createDatabase, createSupabaseDatabase } = require('./db');

test('JSON collections persist across restarts and retain order photos', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-logistics-'));
  try {
    const database = createDatabase(directory);
    database.insert('users', {
      id: 'user-1',
      email: 'customer@example.com',
      name: 'Test Customer',
      phone: '555-0100',
      password_salt: 'salt',
      password_hash: 'hash',
      role: 'customer',
      registered_at: 1,
    });

    test('Supabase initialization includes safe network cause details', async () => {
      const database = createSupabaseDatabase({
        url: 'https://example.supabase.co',
        serviceRoleKey: 'never-log-this-key',
        fetch: async () => {
          const cause = Object.assign(new Error('getaddrinfo ENOTFOUND invalid.supabase.co'), {
            code: 'ENOTFOUND',
          });
          throw new TypeError('fetch failed', { cause });
        },
      });

      await assert.rejects(database.initialize(), error => {
        assert.match(error.message, /ENOTFOUND/);
        assert.match(error.message, /invalid\.supabase\.co/);
        assert.doesNotMatch(error.message, /never-log-this-key/);
        return true;
      });
    });

    test('Supabase adapter preserves records and package photo bytes across CRUD operations', async () => {
      const rows = new Map();
      let authorizationHeader;
      const database = createSupabaseDatabase({
        url: 'https://example.supabase.co',
        serviceRoleKey: 'test-service-role-key',
        fetch: async (url, options = {}) => {
          authorizationHeader = options.headers.Authorization;
          const parsedUrl = new URL(url);
          const method = options.method || 'GET';
          let result = [];

          if (method === 'GET') {
            const collection = parsedUrl.searchParams.get('collection')?.replace(/^eq\./, '');
            result = [...rows.values()].filter(row => !collection || row.collection === collection);
          } else if (method === 'POST') {
            result = JSON.parse(options.body);
            for (const row of result) rows.set(`${row.collection}:${row.record_id}`, row);
          } else if (method === 'DELETE') {
            const collection = parsedUrl.searchParams.get('collection')?.replace(/^eq\./, '');
            const ids = parsedUrl.searchParams.get('record_id')?.replace(/^in\.\((.*)\)$/, '$1').split(',') || [];
            for (const id of ids) rows.delete(`${collection}:${decodeURIComponent(id)}`);
          }

          return new Response(options.headers.Prefer?.includes('return=minimal') ? '' : JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      await database.initialize();
      const photo = Buffer.from([0, 1, 2, 255]);
      await database.insert('orders', {
        id: 'order-1',
        reference: 'AO-TEST-01',
        photo,
        photo_type: 'image/png',
      });
      assert.equal(authorizationHeader, 'Bearer test-service-role-key');
      assert.deepEqual((await database.find('orders', order => order.id === 'order-1')).photo, photo);

      await database.update('orders', order => order.id === 'order-1', order => ({
        ...order,
        status: 'Confirmed',
      }));
      assert.equal((await database.list('orders'))[0].status, 'Confirmed');
      assert.equal(await database.remove('orders', order => order.id === 'order-1'), 1);
      assert.deepEqual(await database.list('orders'), []);
    });

    test('Supabase adapter requires production credentials', () => {
      assert.throws(() => createSupabaseDatabase({ url: '', serviceRoleKey: '' }), /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
    });

    test('Supabase adapter accepts a project reference entered without its full URL', async () => {
      let requestedUrl;
      const database = createSupabaseDatabase({
        url: 'https:okpwuahjeejmnpileweb',
        serviceRoleKey: 'test-service-role-key',
        fetch: async url => {
          requestedUrl = url;
          return new Response('[]', { status: 200 });
        },
      });

      await database.initialize();
      assert.equal(requestedUrl, 'https://okpwuahjeejmnpileweb.supabase.co/rest/v1/app_records?select=collection&limit=1');
    });

    test('Supabase initialization reports the database response without exposing credentials', async () => {
      const database = createSupabaseDatabase({
        url: 'https://example.supabase.co',
        serviceRoleKey: 'never-log-this-key',
        fetch: async () => new Response(JSON.stringify({
          code: '42P01',
          message: 'relation "public.app_records" does not exist',
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      });
      await assert.rejects(database.initialize(), error => {
        assert.match(error.message, /relation "public\.app_records" does not exist/);
        assert.match(error.message, /HTTP 404/);
        assert.doesNotMatch(error.message, /never-log-this-key/);
        return true;
      });
    });

    test('Supabase initialization gives actionable advice for app_records permission errors', async () => {
      const database = createSupabaseDatabase({
        url: 'https://example.supabase.co',
        serviceRoleKey: 'never-log-this-key',
        fetch: async () => new Response(JSON.stringify({
          code: '42501',
          message: 'permission denied for table app_records',
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      });

      await assert.rejects(database.initialize(), error => {
        assert.match(error.message, /GRANT ALL ON TABLE public\.app_records TO service_role/);
        assert.match(error.message, /matching project service-role secret/);
        assert.doesNotMatch(error.message, /never-log-this-key/);
        return true;
      });
    });

    test('Render never falls back to local JSON when Supabase credentials are missing', () => {
      const previous = {
        nodeEnv: process.env.NODE_ENV,
        render: process.env.RENDER,
        url: process.env.SUPABASE_URL,
        key: process.env.SUPABASE_SERVICE_ROLE_KEY,
      };
      try {
        process.env.NODE_ENV = 'development';
        process.env.RENDER = 'true';
        delete process.env.SUPABASE_URL;
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        assert.throws(() => createConfiguredDatabase(), /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
      } finally {
        if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous.nodeEnv;
        if (previous.render === undefined) delete process.env.RENDER;
        else process.env.RENDER = previous.render;
        if (previous.url === undefined) delete process.env.SUPABASE_URL;
        else process.env.SUPABASE_URL = previous.url;
        if (previous.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.key;
      }
    });
    database.insert('orders', {
      id: 'order-1',
      reference: 'AO-TEST-01',
      user_id: 'user-1',
      photo: Buffer.from([0, 1, 2, 255]),
      photo_type: 'image/png',
      created_at: 2,
    });
    database.insert('notifications', {
      id: 'notification-1',
      subject: 'Test',
      message: 'Test message',
      audience: 'customers',
      audience_label: 'Users',
      recipient_count: 1,
      created_at: 3,
      recipients: ['customer@example.com'],
    });
    database.close();

    const restartedDatabase = createDatabase(directory);
    assert.equal(restartedDatabase.find('users', user => user.id === 'user-1').email, 'customer@example.com');
    assert.deepEqual(restartedDatabase.find('orders', order => order.id === 'order-1').photo, Buffer.from([0, 1, 2, 255]));
    assert.deepEqual(restartedDatabase.find('notifications', notification => notification.id === 'notification-1').recipients, ['customer@example.com']);
    for (const filename of ['users.json', 'riders.json', 'orders.json', 'notifications.json', 'sessions.json']) {
      assert.ok(Array.isArray(JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'))));
    }
    restartedDatabase.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
