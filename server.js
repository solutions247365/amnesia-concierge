const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database(path.join(__dirname, 'concierge.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS scratchpad (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deadlines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    due_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    auto_finalize INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finalized_at TEXT
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS network_scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interface TEXT NOT NULL DEFAULT '',
    local_mac TEXT NOT NULL DEFAULT '',
    local_ip TEXT NOT NULL DEFAULT '',
    host_count INTEGER NOT NULL DEFAULT 0,
    responded INTEGER NOT NULL DEFAULT 0,
    duration_sec REAL NOT NULL DEFAULT 0,
    raw_output TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS network_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    mac TEXT NOT NULL,
    vendor TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    first_seen_scan INTEGER REFERENCES network_scans(id),
    last_seen_scan INTEGER REFERENCES network_scans(id),
    times_seen INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    flagged INTEGER NOT NULL DEFAULT 0
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_network_devices_mac ON network_devices(mac);
`);

function logActivity(action, entityType, entityId, summary) {
  db.prepare(
    'INSERT INTO activity_log (action, entity_type, entity_id, summary) VALUES (?, ?, ?, ?)'
  ).run(action, entityType, entityId, summary);
}

function autoFinalizeDeadlines() {
  const now = new Date().toISOString();
  const overdue = db.prepare(
    "SELECT id, title FROM deadlines WHERE status = 'active' AND auto_finalize = 1 AND due_at <= ?"
  ).all(now);

  for (const d of overdue) {
    db.prepare(
      "UPDATE deadlines SET status = 'finalized', finalized_at = ? WHERE id = ?"
    ).run(now, d.id);
    logActivity('auto_finalized', 'deadline', d.id, `Deadline "${d.title}" auto-finalized`);
  }
  return overdue.length;
}

setInterval(autoFinalizeDeadlines, 60_000);

// --- Scratchpad ---
app.get('/api/scratchpad', (req, res) => {
  const entries = db.prepare('SELECT * FROM scratchpad ORDER BY created_at DESC').all();
  res.json(entries);
});

app.post('/api/scratchpad', (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });
  const result = db.prepare('INSERT INTO scratchpad (content) VALUES (?)').run(content.trim());
  const entry = db.prepare('SELECT * FROM scratchpad WHERE id = ?').get(result.lastInsertRowid);
  logActivity('created', 'scratchpad', entry.id, `Scratchpad entry added`);
  res.status(201).json(entry);
});

app.delete('/api/scratchpad/:id', (req, res) => {
  const entry = db.prepare('SELECT * FROM scratchpad WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM scratchpad WHERE id = ?').run(req.params.id);
  logActivity('deleted', 'scratchpad', entry.id, `Scratchpad entry removed`);
  res.json({ ok: true });
});

app.get('/api/scratchpad/summary', (req, res) => {
  const entries = db.prepare('SELECT * FROM scratchpad ORDER BY created_at ASC').all();
  if (!entries.length) return res.json({ summary: null });

  const totalEntries = entries.length;
  const totalWords = entries.reduce((sum, e) => sum + e.content.split(/\s+/).filter(Boolean).length, 0);
  const first = entries[0].created_at;
  const last = entries[entries.length - 1].created_at;

  const urlPattern = /https?:\/\/[^\s]+/g;
  const urls = [];
  const keywords = {};
  const lines = [];

  for (const entry of entries) {
    const found = entry.content.match(urlPattern);
    if (found) urls.push(...found);

    const words = entry.content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3);
    for (const w of words) {
      keywords[w] = (keywords[w] || 0) + 1;
    }

    const firstLine = entry.content.split('\n')[0].trim();
    if (firstLine.length > 60) {
      lines.push(firstLine.substring(0, 57) + '...');
    } else {
      lines.push(firstLine);
    }
  }

  const topKeywords = Object.entries(keywords)
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);

  res.json({
    summary: {
      totalEntries,
      totalWords,
      timeRange: { first, last },
      urls,
      topKeywords,
      entryPreviews: lines,
    },
  });
});

app.delete('/api/scratchpad', (req, res) => {
  db.prepare('DELETE FROM scratchpad').run();
  logActivity('cleared', 'scratchpad', null, 'Scratchpad cleared');
  res.json({ ok: true });
});

// --- Notes ---
app.get('/api/notes', (req, res) => {
  const notes = db.prepare('SELECT * FROM notes ORDER BY updated_at DESC').all();
  res.json(notes);
});

app.post('/api/notes', (req, res) => {
  const { title, content } = req.body;
  const result = db.prepare('INSERT INTO notes (title, content) VALUES (?, ?)').run(title || '', content || '');
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(result.lastInsertRowid);
  logActivity('created', 'note', note.id, `Note "${note.title || 'Untitled'}"`);
  res.status(201).json(note);
});

app.put('/api/notes/:id', (req, res) => {
  const { title, content } = req.body;
  db.prepare("UPDATE notes SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?")
    .run(title || '', content || '', req.params.id);
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  logActivity('updated', 'note', note.id, `Note "${note.title || 'Untitled'}"`);
  res.json(note);
});

app.delete('/api/notes/:id', (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
  logActivity('deleted', 'note', note.id, `Note "${note.title || 'Untitled'}"`);
  res.json({ ok: true });
});

// --- Links ---
app.get('/api/links', (req, res) => {
  const links = db.prepare('SELECT * FROM links ORDER BY created_at DESC').all();
  res.json(links);
});

app.post('/api/links', (req, res) => {
  const { url, title, description } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const result = db.prepare('INSERT INTO links (url, title, description) VALUES (?, ?, ?)')
    .run(url, title || '', description || '');
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(result.lastInsertRowid);
  logActivity('created', 'link', link.id, `Link: ${link.url}`);
  res.status(201).json(link);
});

app.delete('/api/links/:id', (req, res) => {
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM links WHERE id = ?').run(req.params.id);
  logActivity('deleted', 'link', link.id, `Link: ${link.url}`);
  res.json({ ok: true });
});

// --- Deadlines ---
app.get('/api/deadlines', (req, res) => {
  autoFinalizeDeadlines();
  const deadlines = db.prepare('SELECT * FROM deadlines ORDER BY due_at ASC').all();
  res.json(deadlines);
});

app.post('/api/deadlines', (req, res) => {
  const { title, description, due_at, auto_finalize } = req.body;
  if (!title || !due_at) return res.status(400).json({ error: 'Title and due_at required' });
  const result = db.prepare('INSERT INTO deadlines (title, description, due_at, auto_finalize) VALUES (?, ?, ?, ?)')
    .run(title, description || '', due_at, auto_finalize !== undefined ? (auto_finalize ? 1 : 0) : 1);
  const deadline = db.prepare('SELECT * FROM deadlines WHERE id = ?').get(result.lastInsertRowid);
  logActivity('created', 'deadline', deadline.id, `Deadline "${deadline.title}" due ${deadline.due_at}`);
  res.status(201).json(deadline);
});

app.put('/api/deadlines/:id', (req, res) => {
  const { title, description, due_at, status, auto_finalize } = req.body;
  const existing = db.prepare('SELECT * FROM deadlines WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE deadlines SET title = ?, description = ?, due_at = ?, status = ?, auto_finalize = ? WHERE id = ?')
    .run(
      title || existing.title,
      description !== undefined ? description : existing.description,
      due_at || existing.due_at,
      status || existing.status,
      auto_finalize !== undefined ? (auto_finalize ? 1 : 0) : existing.auto_finalize,
      req.params.id
    );
  const deadline = db.prepare('SELECT * FROM deadlines WHERE id = ?').get(req.params.id);
  logActivity('updated', 'deadline', deadline.id, `Deadline "${deadline.title}"`);
  res.json(deadline);
});

app.delete('/api/deadlines/:id', (req, res) => {
  const deadline = db.prepare('SELECT * FROM deadlines WHERE id = ?').get(req.params.id);
  if (!deadline) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM deadlines WHERE id = ?').run(req.params.id);
  logActivity('deleted', 'deadline', deadline.id, `Deadline "${deadline.title}"`);
  res.json({ ok: true });
});

// --- Network Recon ---
const OUI_DB = {
  '64:75:da': 'Arcadyan (Router/ISP CPE)',
  '28:c5:c8': 'HP Inc.',
  'c0:35:32': 'HP Inc.',
  '48:3f:da': 'Tuya Smart',
  'fc:3c:d7': 'TP-Link',
  'c4:82:e1': 'Foxconn / Cloud Network',
  '7c:f6:66': 'Tuya Smart',
  'd8:1f:12': 'Tuya Smart',
  'fc:b4:67': 'Tuya Smart',
  'a0:92:08': 'Tuya Smart',
  '18:de:50': 'Intel Corporate',
  'f8:4f:ad': 'Shenzhen Bilian',
  '40:24:b2': 'Netgear',
  '84:30:95': 'ShenZhen Ogemray',
  '50:03:cf': 'TP-Link',
  'd4:2c:3d': 'Sky Light Digital',
  '68:76:27': 'Zhuhai Dingzhi Electronic',
  '44:f7:9f': 'Foxconn / Cloud Network',
  '00:2a:2a': 'Samsung',
  'aa:bb:cc': 'Generic',
};

function lookupVendor(mac) {
  if (!mac) return '';
  const prefix = mac.toLowerCase().substring(0, 8);
  if (OUI_DB[prefix]) return OUI_DB[prefix];
  const first = parseInt(mac.split(':')[0], 16);
  if (first & 0x02) return '(Locally Administered / Randomized)';
  return '';
}

function parseArpScanOutput(raw) {
  const lines = raw.split('\n');
  const devices = [];
  let iface = '', localMac = '', localIp = '', hostCount = 0, responded = 0, duration = 0;

  for (const line of lines) {
    const ifMatch = line.match(/Interface:\s*(\S+),.*MAC:\s*([0-9a-f:]{17}),.*IPv4:\s*(\S+)/i);
    if (ifMatch) {
      iface = ifMatch[1];
      localMac = ifMatch[2].toLowerCase();
      localIp = ifMatch[3];
      continue;
    }

    const devMatch = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f:]{17})\s*(.*)/i);
    if (devMatch) {
      devices.push({
        ip: devMatch[1],
        mac: devMatch[2].toLowerCase(),
        vendor_reported: devMatch[3].replace(/[()]/g, '').trim(),
      });
      continue;
    }

    const statsMatch = line.match(/(\d+)\s+hosts\s+scanned.*?(\d+(?:\.\d+)?)\s+seconds.*?(\d+)\s+responded/i);
    if (!statsMatch) {
      const altStats = line.match(/Ending.*?(\d+)\s+hosts\s+scanned\s+in\s+(\d+(?:\.\d+)?)\s+seconds/i);
      if (altStats) {
        hostCount = parseInt(altStats[1]);
        duration = parseFloat(altStats[2]);
      }
      const respMatch = line.match(/(\d+)\s+responded/);
      if (respMatch) responded = parseInt(respMatch[1]);
    } else {
      hostCount = parseInt(statsMatch[1]);
      duration = parseFloat(statsMatch[2]);
      responded = parseInt(statsMatch[3]);
    }
  }

  if (!responded && devices.length) responded = devices.length;

  return { iface, localMac, localIp, hostCount, responded, duration, devices };
}

app.post('/api/network/scan', (req, res) => {
  const { raw_output } = req.body;
  if (!raw_output || !raw_output.trim()) return res.status(400).json({ error: 'Paste arp-scan output' });

  const parsed = parseArpScanOutput(raw_output);
  if (!parsed.devices.length) return res.status(400).json({ error: 'No devices found in output' });

  const scanResult = db.prepare(
    'INSERT INTO network_scans (interface, local_mac, local_ip, host_count, responded, duration_sec, raw_output) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(parsed.iface, parsed.localMac, parsed.localIp, parsed.hostCount, parsed.responded, parsed.duration, raw_output.trim());

  const scanId = scanResult.lastInsertRowid;
  let newCount = 0;
  let updatedCount = 0;

  const findByMac = db.prepare('SELECT * FROM network_devices WHERE mac = ?');
  const insertDev = db.prepare(
    'INSERT INTO network_devices (ip, mac, vendor, first_seen_scan, last_seen_scan) VALUES (?, ?, ?, ?, ?)'
  );
  const updateDev = db.prepare(
    "UPDATE network_devices SET ip = ?, vendor = CASE WHEN vendor = '' THEN ? ELSE vendor END, last_seen_scan = ?, times_seen = times_seen + 1, last_seen_at = datetime('now') WHERE mac = ?"
  );

  for (const dev of parsed.devices) {
    const vendor = lookupVendor(dev.mac) || dev.vendor_reported;
    const existing = findByMac.get(dev.mac);
    if (existing) {
      updateDev.run(dev.ip, vendor, scanId, dev.mac);
      updatedCount++;
    } else {
      insertDev.run(dev.ip, dev.mac, vendor, scanId, scanId);
      newCount++;
    }
  }

  logActivity('scan_imported', 'network', scanId, `Scan: ${parsed.responded} devices (${newCount} new, ${updatedCount} seen before)`);

  res.status(201).json({
    scan_id: scanId,
    devices_found: parsed.devices.length,
    new_devices: newCount,
    updated_devices: updatedCount,
  });
});

app.get('/api/network/devices', (req, res) => {
  const devices = db.prepare("SELECT * FROM network_devices ORDER BY CAST(REPLACE(ip, '.', '') AS INTEGER)").all();
  res.json(devices);
});

app.put('/api/network/devices/:id', (req, res) => {
  const { label, notes, flagged } = req.body;
  const existing = db.prepare('SELECT * FROM network_devices WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE network_devices SET label = ?, notes = ?, flagged = ? WHERE id = ?').run(
    label !== undefined ? label : existing.label,
    notes !== undefined ? notes : existing.notes,
    flagged !== undefined ? (flagged ? 1 : 0) : existing.flagged,
    req.params.id
  );
  const device = db.prepare('SELECT * FROM network_devices WHERE id = ?').get(req.params.id);
  logActivity('updated', 'network_device', device.id, `Device ${device.ip} (${device.mac})`);
  res.json(device);
});

app.delete('/api/network/devices/:id', (req, res) => {
  const device = db.prepare('SELECT * FROM network_devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM network_devices WHERE id = ?').run(req.params.id);
  logActivity('deleted', 'network_device', device.id, `Device ${device.ip} (${device.mac})`);
  res.json({ ok: true });
});

app.get('/api/network/scans', (req, res) => {
  const scans = db.prepare('SELECT id, interface, local_ip, host_count, responded, duration_sec, created_at FROM network_scans ORDER BY created_at DESC').all();
  res.json(scans);
});

app.get('/api/network/scans/:id', (req, res) => {
  const scan = db.prepare('SELECT * FROM network_scans WHERE id = ?').get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });
  res.json(scan);
});

app.delete('/api/network/scans/:id', (req, res) => {
  const scan = db.prepare('SELECT * FROM network_scans WHERE id = ?').get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM network_scans WHERE id = ?').run(req.params.id);
  logActivity('deleted', 'network_scan', scan.id, `Scan from ${scan.created_at}`);
  res.json({ ok: true });
});

// --- Activity / Summary ---
app.get('/api/activity', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const activity = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json(activity);
});

app.get('/api/summary', (req, res) => {
  const deviceCount = db.prepare('SELECT COUNT(*) as count FROM network_devices').get().count;
  const flaggedCount = db.prepare('SELECT COUNT(*) as count FROM network_devices WHERE flagged = 1').get().count;
  const noteCount = db.prepare('SELECT COUNT(*) as count FROM notes').get().count;
  const linkCount = db.prepare('SELECT COUNT(*) as count FROM links').get().count;
  const activeDeadlines = db.prepare("SELECT COUNT(*) as count FROM deadlines WHERE status = 'active'").get().count;
  const finalizedDeadlines = db.prepare("SELECT COUNT(*) as count FROM deadlines WHERE status = 'finalized'").get().count;
  const overdueDeadlines = db.prepare(
    "SELECT COUNT(*) as count FROM deadlines WHERE status = 'active' AND due_at <= datetime('now')"
  ).get().count;
  const recentActivity = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 10').all();

  res.json({
    devices: deviceCount,
    flagged: flaggedCount,
    notes: noteCount,
    links: linkCount,
    deadlines: { active: activeDeadlines, finalized: finalizedDeadlines, overdue: overdueDeadlines },
    recentActivity,
  });
});

app.listen(PORT, () => {
  console.log(`Amnesia Concierge running on port ${PORT}`);
});
