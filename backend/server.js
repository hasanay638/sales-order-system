const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');
const DB_PATH = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'sales-order-system', 'sales-system-v2.sqlite');
const IMPORT_SCRIPT = path.join(__dirname, 'scripts', 'import_sales_data.py');
const GATEWAY_SCRIPT = path.join(__dirname, 'scripts', 'db_gateway.py');

const app = express();
app.use(express.json());
app.use(express.static(FRONTEND_DIR));

function runPython(script, payload) {
  const result = spawnSync('python', [script], {
    input: payload ? JSON.stringify(payload) : undefined,
    encoding: 'utf-8'
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    let message = stderr || stdout || 'Islem basarisiz oldu.';
    try {
      const parsed = JSON.parse(stdout);
      message = parsed.error || message;
    } catch {
      // keep message
    }
    throw new Error(message);
  }

  if (!result.stdout.trim()) {
    return null;
  }

  return JSON.parse(result.stdout);
}

function ensureDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    runPython(IMPORT_SCRIPT);
  }
}

app.post('/api/login', (req, res, next) => {
  try {
    res.json(runPython(GATEWAY_SCRIPT, { action: 'login', ...req.body }));
  } catch (error) {
    error.status = 401;
    next(error);
  }
});

app.get('/api/bootstrap', (_req, res, next) => {
  try {
    res.json(runPython(GATEWAY_SCRIPT, { action: 'bootstrap' }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/customers', (req, res, next) => {
  try {
    res.json(runPython(GATEWAY_SCRIPT, { action: 'create_customer', ...req.body }));
  } catch (error) {
    next(error);
  }
});

app.put('/api/customers/:id/assignment', (req, res, next) => {
  try {
    res.json(runPython(GATEWAY_SCRIPT, { action: 'update_customer_assignment', customerId: req.params.id, ...req.body }));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/customers/:id', (req, res, next) => {
  try {
    res.json(runPython(GATEWAY_SCRIPT, { action: 'delete_customer', customerId: req.params.id }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/orders', (req, res, next) => {
  try {
    res.json(runPython(GATEWAY_SCRIPT, { action: 'create_order', now: new Date().toISOString(), ...req.body }));
  } catch (error) {
    next(error);
  }
});

app.put('/api/orders/:id', (req, res, next) => {
  try {
    res.json(runPython(GATEWAY_SCRIPT, { action: 'update_order', orderId: req.params.id, now: new Date().toISOString(), ...req.body }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/orders/:id/approve', (req, res, next) => {
  try {
    res.json(runPython(GATEWAY_SCRIPT, { action: 'approve_order', orderId: req.params.id, now: new Date().toISOString() }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/reset', (_req, res, next) => {
  try {
    runPython(IMPORT_SCRIPT);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  const requestPath = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
  const filePath = path.join(FRONTEND_DIR, requestPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.sendFile(filePath);
    return;
  }
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.use((error, _req, res, _next) => {
  res.status(error.status || 500).json({ message: error.message || 'Sunucu hatasi.' });
});

ensureDatabase();
app.listen(PORT, () => {
  console.log(`Portal hazir: http://localhost:${PORT}`);
});
