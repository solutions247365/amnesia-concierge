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

// --- Activity / Summary ---
app.get('/api/activity', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const activity = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json(activity);
});

app.get('/api/summary', (req, res) => {
  const noteCount = db.prepare('SELECT COUNT(*) as count FROM notes').get().count;
  const linkCount = db.prepare('SELECT COUNT(*) as count FROM links').get().count;
  const activeDeadlines = db.prepare("SELECT COUNT(*) as count FROM deadlines WHERE status = 'active'").get().count;
  const finalizedDeadlines = db.prepare("SELECT COUNT(*) as count FROM deadlines WHERE status = 'finalized'").get().count;
  const overdueDeadlines = db.prepare(
    "SELECT COUNT(*) as count FROM deadlines WHERE status = 'active' AND due_at <= datetime('now')"
  ).get().count;
  const recentActivity = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 10').all();

  res.json({
    notes: noteCount,
    links: linkCount,
    deadlines: { active: activeDeadlines, finalized: finalizedDeadlines, overdue: overdueDeadlines },
    recentActivity,
  });
});

app.listen(PORT, () => {
  console.log(`Amnesia Concierge running on port ${PORT}`);
});
