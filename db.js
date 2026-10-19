const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const collections = ['users', 'riders', 'orders', 'notifications', 'sessions'];

function uniqueError() {
  const error = new Error('A record with a unique field already exists.');
  error.code = 'JSON_CONSTRAINT_UNIQUE';
  return error;
}

function importLegacyDatabase(filename) {
  if (!fs.existsSync(filename)) return null;
  const legacy = new DatabaseSync(filename, { readOnly: true });
  try {
    const state = Object.fromEntries(collections.map(name => [name, []]));
    for (const name of ['users', 'riders', 'orders', 'notifications', 'sessions']) {
      state[name] = legacy.prepare(`SELECT * FROM ${name}`).all().map(row => {
        if (name === 'orders') row.photo = Buffer.from(row.photo).toString('base64');
        return row;
      });
    }
    const recipients = legacy.prepare('SELECT notification_id, email FROM notification_recipients').all();
    for (const notification of state.notifications) {
      notification.recipients = recipients
        .filter(recipient => recipient.notification_id === notification.id)
        .map(recipient => recipient.email);
    }
    return state;
  } finally {
    legacy.close();
  }
}

function createDatabase(directory = path.join(__dirname, 'data')) {
  const inMemory = directory === ':memory:';
  const dataDirectory = inMemory ? null : directory;
  if (dataDirectory) fs.mkdirSync(dataDirectory, { recursive: true });

  let state;
  if (inMemory) {
    state = Object.fromEntries(collections.map(name => [name, []]));
  } else {
    const legacyPath = path.join(dataDirectory, 'ao-logistics.sqlite');
    const migrationMarker = path.join(dataDirectory, '.json-migration-complete');
    state = fs.existsSync(migrationMarker) ? null : importLegacyDatabase(legacyPath);
    if (state) {
      for (const name of collections) {
        const filename = path.join(dataDirectory, `${name}.json`);
        const temporary = `${filename}.${process.pid}.migration.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify(state[name], null, 2)}\n`, { flag: 'w', mode: 0o600 });
        fs.renameSync(temporary, filename);
      }
      fs.writeFileSync(migrationMarker, 'complete\n', { flag: 'wx', mode: 0o600 });
    }
    if (!state) state = Object.fromEntries(collections.map(name => [name, []]));
    for (const name of collections) {
      const filename = path.join(dataDirectory, `${name}.json`);
      if (!fs.existsSync(filename)) {
        fs.writeFileSync(filename, '[]\n', { flag: 'wx', mode: 0o600 });
      } else {
        const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (!Array.isArray(parsed)) throw new Error(`${name}.json must contain a JSON array.`);
        state[name] = parsed;
      }
    }
  }

  function persist(name) {
    if (!dataDirectory) return;
    const filename = path.join(dataDirectory, `${name}.json`);
    const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(state[name], null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, filename);
    } catch (error) {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      throw error;
    }
  }

  function storedRecord(name, record) {
    const copy = { ...record };
    if (name === 'orders' && Buffer.isBuffer(copy.photo)) copy.photo = copy.photo.toString('base64');
    return copy;
  }

  function returnedRecord(name, record) {
    if (!record) return record;
    const copy = { ...record };
    if (name === 'orders' && typeof copy.photo === 'string') copy.photo = Buffer.from(copy.photo, 'base64');
    return copy;
  }

  return {
    find(name, predicate) {
      const record = state[name].find(predicate);
      return returnedRecord(name, record);
    },
    list(name, predicate = () => true) {
      return state[name].filter(predicate).map(record => returnedRecord(name, record));
    },
    insert(name, record) {
      const normalized = storedRecord(name, record);
      const email = normalized.email?.toLowerCase();
      if (name === 'users' || name === 'riders') {
        if (state[name].some(existing => existing.email.toLowerCase() === email)) throw uniqueError();
      }
      if ((normalized.id && state[name].some(existing => existing.id === normalized.id))
        || (name === 'sessions' && state[name].some(existing => existing.token_hash === normalized.token_hash))
        || (name === 'orders' && state[name].some(existing => existing.reference === normalized.reference))
        || (name === 'riders' && state[name].some(existing => existing.reference === normalized.reference))) {
        throw uniqueError();
      }
      state[name].push(normalized);
      try {
        persist(name);
      } catch (error) {
        state[name].pop();
        throw error;
      }
      return returnedRecord(name, normalized);
    },
    update(name, predicate, updateRecord) {
      const index = state[name].findIndex(predicate);
      if (index === -1) return null;
      const previous = state[name][index];
      state[name][index] = storedRecord(name, updateRecord(returnedRecord(name, previous)));
      try {
        persist(name);
      } catch (error) {
        state[name][index] = previous;
        throw error;
      }
      return returnedRecord(name, state[name][index]);
    },
    remove(name, predicate) {
      const removed = [];
      const previousState = state[name];
      const retained = [];
      for (const record of state[name]) {
        if (predicate(record)) removed.push(record);
        else retained.push(record);
      }
      if (!removed.length) return 0;
      state[name] = retained;
      try {
        persist(name);
      } catch (error) {
        state[name] = previousState;
        throw error;
      }
      return removed.length;
    },
    close() {},
  };
}

function createSupabaseDatabase({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  if (!url || !serviceRoleKey) {
    throw new Error('Production requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }
  const projectReference = /^(?:https:)?([a-z0-9]{20})$/i.exec(url.trim());
  if (projectReference) {
    url = `https://${projectReference[1].toLowerCase()}.supabase.co`;
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('SUPABASE_URL must be a valid HTTP(S) URL.');
  }
  if (!['https:', 'http:'].includes(parsedUrl.protocol) || !fetchImpl) {
    throw new Error('SUPABASE_URL must be a valid HTTP(S) URL and fetch must be available.');
  }

  const endpoint = new URL('/rest/v1/app_records', parsedUrl);
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };

  function throwResponseError(body, status) {
    const error = new Error(body?.message || body?.details || `Supabase request failed with HTTP ${status}.`);
    error.code = body?.code || (status === 409 ? '23505' : undefined);
    error.status = status;
    throw error;
  }

  async function request({ method = 'GET', query = '', body, prefer = '' } = {}) {
    let response;
    try {
      response = await fetchImpl(`${endpoint}${query}`, {
        method,
        headers: {
          ...headers,
          ...(prefer ? { Prefer: prefer } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      const error = new Error('Could not connect to Supabase PostgreSQL.', { cause });
      error.code = 'SUPABASE_CONNECTION_ERROR';
      throw error;
    }
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }
    if (!response.ok) throwResponseError(payload, response.status);
    return payload;
  }

  function decodeRecord(row) {
    const record = { ...row.data };
    if (!Object.hasOwn(record, 'id') && row.collection === 'sessions') {
      record.id = row.record_id;
    }
    if (row.collection === 'orders' && typeof record.photo === 'string') {
      record.photo = Buffer.from(record.photo, 'base64');
    }
    return record;
  }

  function encodeRecord(collection, record) {
    if (!collections.includes(collection)) throw new Error(`Unknown collection: ${collection}`);
    const data = { ...record };
    if (collection === 'orders' && Buffer.isBuffer(data.photo)) {
      data.photo = data.photo.toString('base64');
    }
    const recordId = record.id || (collection === 'sessions' ? record.token_hash : null);
    if (!recordId) throw new Error(`${collection} records require an id${collection === 'sessions' ? ' or token_hash' : ''}.`);
    return {
      collection,
      record_id: String(recordId),
      email: record.email == null ? null : String(record.email),
      reference: record.reference == null ? null : String(record.reference),
      token_hash: record.token_hash == null ? null : String(record.token_hash),
      data,
    };
  }

  async function getRecords(collection) {
    const records = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const query = `?collection=eq.${encodeURIComponent(collection)}&select=collection,record_id,email,reference,token_hash,data&limit=${pageSize}&offset=${offset}`;
      const page = await request({ query });
      records.push(...page.map(decodeRecord));
      if (page.length < pageSize) return records;
    }
  }

  return {
    async initialize() {
      try {
        await request({ query: '?select=collection&limit=1' });
      } catch (error) {
        const status = error?.status ? ` (HTTP ${error.status})` : '';
        let cause = error?.cause;
        while (cause?.cause && cause.cause !== cause) cause = cause.cause;
        const causeDetail = [cause?.code, cause?.message].filter(Boolean).join(': ');
        const detail = `${error?.message || 'Unknown Supabase error.'}${status}${causeDetail ? ` (${causeDetail})` : ''}`;
        const permissionAdvice = /permission denied for table ["']?app_records/i.test(error?.message || '')
          ? ' Run GRANT ALL ON TABLE public.app_records TO service_role in Supabase SQL Editor, and verify SUPABASE_SERVICE_ROLE_KEY is the matching project service-role secret (not an anon/publishable key).'
          : ' Ensure public.app_records and its required constraints exist, and verify the service-role credentials.';
        throw new Error(
          `Supabase connection/schema check failed: ${detail}${permissionAdvice}`,
          { cause: error },
        );
      }
    },
    async find(collection, predicate) {
      return (await getRecords(collection)).find(predicate);
    },
    async list(collection, predicate = () => true) {
      return (await getRecords(collection)).filter(predicate);
    },
    async insert(collection, record) {
      const [saved] = await request({
        method: 'POST',
        query: '?select=collection,record_id,email,reference,token_hash,data',
        body: [encodeRecord(collection, record)],
        prefer: 'return=representation',
      });
      return decodeRecord(saved);
    },
    async update(collection, predicate, updateRecord) {
      const records = await getRecords(collection);
      const previous = records.find(predicate);
      if (!previous) return null;
      const updated = updateRecord(previous);
      const [saved] = await request({
        method: 'POST',
        query: '?on_conflict=collection,record_id&select=collection,record_id,email,reference,token_hash,data',
        body: [encodeRecord(collection, updated)],
        prefer: 'resolution=merge-duplicates,return=representation',
      });
      return decodeRecord(saved);
    },
    async remove(collection, predicate) {
      const matches = (await getRecords(collection)).filter(predicate);
      if (!matches.length) return 0;
      const ids = matches.map(record => encodeURIComponent(String(
        record.id || (collection === 'sessions' ? record.token_hash : ''),
      ))).join(',');
      await request({
        method: 'DELETE',
        query: `?collection=eq.${encodeURIComponent(collection)}&record_id=in.(${ids})`,
        prefer: 'return=minimal',
      });
      return matches.length;
    },
    async close() {},
  };
}

function createConfiguredDatabase() {
  const production = process.env.NODE_ENV === 'production';
  const render = process.env.RENDER === 'true';
  const hasSupabaseConfig = Boolean(process.env.SUPABASE_URL || process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (production || render || hasSupabaseConfig) return createSupabaseDatabase();
  return createDatabase();
}

module.exports = { createDatabase, createSupabaseDatabase, createConfiguredDatabase };
