const express = require('express');
const path = require('node:path');
const db = require('./db');
const { hashPassword, verifyPassword, createSession, loadUser, requireAuth, destroySession } = require('./auth');

const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(loadUser);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const usernameRe = /^[a-zA-Z0-9_]{3,20}$/;
const text = (v, max) => (typeof v === 'string' ? v.trim() : '').slice(0, max);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// auth
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!usernameRe.test(username || '')) return bad(res, 'Username must be 3-20 letters, numbers or _');
  if (typeof password !== 'string' || password.length < 6 || password.length > 100)
    return bad(res, 'Password must be 6-100 characters');
  if (db.prepare('select 1 from users where username = ?').get(username)) return bad(res, 'Username is taken', 409);

  const { lastInsertRowid } = db.prepare('insert into users (username, password_hash) values (?, ?)')
    .run(username, hashPassword(password));
  createSession(res, lastInsertRowid);
  res.status(201).json({ id: Number(lastInsertRowid), username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = typeof username === 'string' && db.prepare('select * from users where username = ?').get(username);
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
  db.prepare('update users set bio = ? where id = ?').run(bio, req.user.id);
  res.json({ bio });
});

// posts
// post + author + like/comment counts + whether i liked it, all in one query
const postSelect = `
  select p.id, p.body, p.created_at, u.username,
    (select count(*) from likes l where l.post_id = p.id) as like_count,
    (select count(*) from comments c where c.post_id = p.id) as comment_count,
    exists (select 1 from likes l where l.post_id = p.id and l.user_id = :me) as liked_by_me,
    p.user_id = :me as mine
  from posts p join users u on u.id = p.user_id`;

app.get('/api/feed', requireAuth, (req, res) => {
  const where = req.query.scope === 'all'
    ? ''
    : 'where p.user_id = :me or p.user_id in (select following_id from follows where follower_id = :me)';
  res.json(db.prepare(`${postSelect} ${where} order by p.id desc limit 50`).all({ me: req.user.id }));
});

app.post('/api/posts', requireAuth, (req, res) => {
  const body = text(req.body?.body, 500);
  if (!body) return bad(res, 'Post cannot be empty');
  const { lastInsertRowid } = db.prepare('insert into posts (user_id, body) values (?, ?)').run(req.user.id, body);
  res.status(201).json(db.prepare(`${postSelect} where p.id = :id`).get({ me: req.user.id, id: lastInsertRowid }));
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const { changes } = db.prepare('delete from posts where id = ? and user_id = ?').run(req.params.id, req.user.id);
  if (!changes) return bad(res, 'Post not found', 404);
  res.json({ ok: true });
});

const postExists = id => db.prepare('select 1 from posts where id = ?').get(id);

app.post('/api/posts/:id/like', requireAuth, (req, res) => {
  const id = req.params.id;
  if (!postExists(id)) return bad(res, 'Post not found', 404);
  // try deleting the like first, if nothing got deleted then add it
  const removed = db.prepare('delete from likes where user_id = ? and post_id = ?').run(req.user.id, id).changes;
  if (!removed) db.prepare('insert into likes (user_id, post_id) values (?, ?)').run(req.user.id, id);
  const { n } = db.prepare('select count(*) as n from likes where post_id = ?').get(id);
  res.json({ liked: !removed, like_count: n });
});

// comments
const commentSelect = `select c.id, c.body, c.created_at, u.username
  from comments c join users u on u.id = c.user_id`;

app.get('/api/posts/:id/comments', requireAuth, (req, res) => {
  res.json(db.prepare(`${commentSelect} where c.post_id = ? order by c.id`).all(req.params.id));
});

app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const body = text(req.body?.body, 300);
  if (!body) return bad(res, 'Comment cannot be empty');
  if (!postExists(req.params.id)) return bad(res, 'Post not found', 404);
  const { lastInsertRowid } = db.prepare('insert into comments (post_id, user_id, body) values (?, ?, ?)')
    .run(req.params.id, req.user.id, body);
  res.status(201).json(db.prepare(`${commentSelect} where c.id = ?`).get(lastInsertRowid));
});

// profiles and follows
app.get('/api/users', requireAuth, (req, res) => {
  // who to follow = people i'm not following yet
  res.json(db.prepare(`select username, bio from users where id <> :me
    and id not in (select following_id from follows where follower_id = :me)
    order by id desc limit 5`).all({ me: req.user.id }));
});

app.get('/api/users/:username', requireAuth, (req, res) => {
  const me = req.user.id;
  const user = db.prepare(`select id, username, bio, created_at,
      (select count(*) from follows where following_id = users.id) as followers,
      (select count(*) from follows where follower_id = users.id) as following,
      exists (select 1 from follows where follower_id = :me and following_id = users.id) as followed_by_me
    from users where username = :username`).get({ me, username: req.params.username });
  if (!user) return bad(res, 'User not found', 404);
  user.posts = db.prepare(`${postSelect} where p.user_id = :uid order by p.id desc limit 50`).all({ me, uid: user.id });
  user.is_me = user.id === me;
  delete user.id;
  res.json(user);
});

app.post('/api/users/:username/follow', requireAuth, (req, res) => {
  const target = db.prepare('select id from users where username = ?').get(req.params.username);
  if (!target) return bad(res, 'User not found', 404);
  if (target.id === req.user.id) return bad(res, 'You cannot follow yourself');
  const removed = db.prepare('delete from follows where follower_id = ? and following_id = ?').run(req.user.id, target.id).changes;
  if (!removed) db.prepare('insert into follows (follower_id, following_id) values (?, ?)').run(req.user.id, target.id);
  const { n } = db.prepare('select count(*) as n from follows where following_id = ?').get(target.id);
  res.json({ following: !removed, followers: n });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Social app running at http://localhost:${port}`));
}

module.exports = app;
