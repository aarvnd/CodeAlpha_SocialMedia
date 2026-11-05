const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.DB_FILE || 'social.db');
db.exec(`
  pragma journal_mode = wal;
  pragma foreign_keys = on;

  create table if not exists users (
    id integer primary key,
    username text unique not null collate nocase,
    password_hash text not null,
    bio text not null default '',
    created_at text not null default current_timestamp
  );
  create table if not exists sessions (
    token text primary key,
    user_id integer not null references users(id) on delete cascade,
    expires_at integer not null
  );
  create table if not exists posts (
    id integer primary key,
    user_id integer not null references users(id) on delete cascade,
    body text not null,
    created_at text not null default current_timestamp
  );
  create table if not exists comments (
    id integer primary key,
    post_id integer not null references posts(id) on delete cascade,
    user_id integer not null references users(id) on delete cascade,
    body text not null,
    created_at text not null default current_timestamp
  );
  -- pk on both columns so you can't like/follow the same thing twice
  create table if not exists likes (
    user_id integer not null references users(id) on delete cascade,
    post_id integer not null references posts(id) on delete cascade,
    primary key (user_id, post_id)
  );
  create table if not exists follows (
    follower_id integer not null references users(id) on delete cascade,
    following_id integer not null references users(id) on delete cascade,
    primary key (follower_id, following_id),
    check (follower_id <> following_id)
  );
  create index if not exists idx_posts_user on posts(user_id, id);
  create index if not exists idx_comments_post on comments(post_id, id);
`);

module.exports = db;
