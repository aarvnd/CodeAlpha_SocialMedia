const express = require('express');
const path = require('node:path');
const db = require('./db');
const { hashPassword, verifyPassword, createSession, loadUser, requireAuth, destroySession } = require('./auth');

const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(loadUser);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const text = (v, max) => (typeof v === 'string' ? v.trim() : '').slice(0, max);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---------- Auth ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!USERNAME_RE.test(username || '')) return bad(res, 'Username must be 3-20 letters, numbers or _');
  if (typeof password !== 'string' || password.length < 6 || password.length > 100)
    return bad(res, 'Password must be 6-100 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return bad(res, 'Username is taken', 409);

  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, hashPassword(password));
  createSession(res, lastInsertRowid);
  res.status(201).json({ id: Number(lastInsertRowid), username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = typeof username === 'string' && db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || typeof password !== 'string' || !verifyPassword(password, user.password_hash))
    return bad(res, 'Wrong username or password', 401);
  createSession(res, user.id);
  res.json({ id: user.id, username: user.username });
});

app.post('/api/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

app.patch('/api/me', requireAuth, (req, res) => {
  const bio = text(req.body?.bio, 160);
  db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, req.user.id);
  res.json({ bio });
});

// ---------- Posts ----------
// One query gives each post its author, like/comment counts and whether *I* liked it
const POST_SELECT = `
  SELECT p.id, p.body, p.created_at, u.username,
    (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
    (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
    EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = :me) AS liked_by_me,
    p.user_id = :me AS mine
  FROM posts p JOIN users u ON u.id = p.user_id`;

app.get('/api/feed', requireAuth, (req, res) => {
  const where = req.query.scope === 'all'
    ? ''
    : 'WHERE p.user_id = :me OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = :me)';
  res.json(db.prepare(`${POST_SELECT} ${where} ORDER BY p.id DESC LIMIT 50`).all({ me: req.user.id }));
});

app.post('/api/posts', requireAuth, (req, res) => {
  const body = text(req.body?.body, 500);
  if (!body) return bad(res, 'Post cannot be empty');
  const { lastInsertRowid } = db.prepare('INSERT INTO posts (user_id, body) VALUES (?, ?)').run(req.user.id, body);
  res.status(201).json(db.prepare(`${POST_SELECT} WHERE p.id = :id`).get({ me: req.user.id, id: lastInsertRowid }));
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const { changes } = db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!changes) return bad(res, 'Post not found', 404);
  res.json({ ok: true });
});

const postExists = id => db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id);

app.post('/api/posts/:id/like', requireAuth, (req, res) => {
  const id = req.params.id;
  if (!postExists(id)) return bad(res, 'Post not found', 404);
  // Toggle: try to remove the like; if there was none, add it
  const removed = db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, id).changes;
  if (!removed) db.prepare('INSERT INTO likes (user_id, post_id) VALUES (?, ?)').run(req.user.id, id);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(id);
  res.json({ liked: !removed, like_count: n });
});

// ---------- Comments ----------
const COMMENT_SELECT = `SELECT c.id, c.body, c.created_at, u.username
  FROM comments c JOIN users u ON u.id = c.user_id`;

app.get('/api/posts/:id/comments', requireAuth, (req, res) => {
  res.json(db.prepare(`${COMMENT_SELECT} WHERE c.post_id = ? ORDER BY c.id`).all(req.params.id));
});

app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const body = text(req.body?.body, 300);
  if (!body) return bad(res, 'Comment cannot be empty');
  if (!postExists(req.params.id)) return bad(res, 'Post not found', 404);
  const { lastInsertRowid } = db.prepare('INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)')
    .run(req.params.id, req.user.id, body);
  res.status(201).json(db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(lastInsertRowid));
});

// ---------- Profiles & follows ----------
app.get('/api/users', requireAuth, (req, res) => {
  // "Who to follow": people I don't follow yet
  res.json(db.prepare(`SELECT username, bio FROM users WHERE id <> :me
    AND id NOT IN (SELECT following_id FROM follows WHERE follower_id = :me)
    ORDER BY id DESC LIMIT 5`).all({ me: req.user.id }));
});

app.get('/api/users/:username', requireAuth, (req, res) => {
  const me = req.user.id;
  const user = db.prepare(`SELECT id, username, bio, created_at,
      (SELECT COUNT(*) FROM follows WHERE following_id = users.id) AS followers,
      (SELECT COUNT(*) FROM follows WHERE follower_id = users.id) AS following,
      EXISTS (SELECT 1 FROM follows WHERE follower_id = :me AND following_id = users.id) AS followed_by_me
    FROM users WHERE username = :username`).get({ me, username: req.params.username });
  if (!user) return bad(res, 'User not found', 404);
  user.posts = db.prepare(`${POST_SELECT} WHERE p.user_id = :uid ORDER BY p.id DESC LIMIT 50`).all({ me, uid: user.id });
  user.is_me = user.id === me;
  delete user.id;
  res.json(user);
});

app.post('/api/users/:username/follow', requireAuth, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (!target) return bad(res, 'User not found', 404);
  if (target.id === req.user.id) return bad(res, 'You cannot follow yourself');
  const removed = db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(req.user.id, target.id).changes;
  if (!removed) db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)').run(req.user.id, target.id);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE following_id = ?').get(target.id);
  res.json({ following: !removed, followers: n });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Social app running at http://localhost:${port}`));
}

module.exports = app;
