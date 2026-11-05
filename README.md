# Pulse — Mini Social Media App

CodeAlpha Full Stack Development internship, **Task 2: Social Media Platform**.

Users can sign up, write posts, comment, like posts and follow each other. The feed shows
posts from the people you follow, with an "Everyone" tab for discovering new people.

## Features
- **User profiles**: avatar, bio (editable), post / follower / following counts
- **Posts & comments**: create and delete your own posts, comment on any post
- **Like / follow system**: one click toggles a like or follow
- **Feed**: "Following" (you + people you follow) and "Everyone"
- **Who to follow** suggestions
- Secure login with hashed passwords and httpOnly session cookies

## Tech stack
| Layer | Used |
|---|---|
| Frontend | HTML, CSS, vanilla JavaScript (`public/`) |
| Backend | Node.js + Express 5 (`server.js`) |
| Database | SQLite through Node's built-in `node:sqlite` (`db.js`) |
| Auth | `crypto.scrypt` password hashing + session tokens (`auth.js`) |

## Run it
Requires **Node.js 22.13+** (for the built-in `node:sqlite`).
```bash
npm install
npm start          # http://localhost:3000
npm test           # API test: register → post → follow → like → comment
```

## Database design
```
users     (id, username, password_hash, bio, created_at)
sessions  (token, user_id, expires_at)
posts     (id, user_id, body, created_at)
comments  (id, post_id, user_id, body, created_at)
likes     (user_id, post_id)            PRIMARY KEY (user_id, post_id)
follows   (follower_id, following_id)   PRIMARY KEY (follower_id, following_id)
```
`likes` and `follows` use a **composite primary key**, so the database itself prevents
liking the same post twice or following the same person twice. `ON DELETE CASCADE` cleans up
likes and comments when a post is deleted.

## API
| Method | Route | What it does |
|---|---|---|
| POST | `/api/register`, `/api/login`, `/api/logout` | Auth |
| GET / PATCH | `/api/me` | Current user / update bio |
| GET | `/api/feed?scope=following\|all` | Feed |
| POST / DELETE | `/api/posts`, `/api/posts/:id` | Create / delete (owner only) |
| POST | `/api/posts/:id/like` | Toggle like |
| GET / POST | `/api/posts/:id/comments` | List / add comments |
| GET | `/api/users`, `/api/users/:username` | Suggestions / profile |
| POST | `/api/users/:username/follow` | Toggle follow |

## Security notes
- Passwords are hashed with **scrypt** + a random salt and compared with `timingSafeEqual`.
- Sessions are random 256-bit tokens in an **httpOnly, SameSite=Lax** cookie, so JavaScript
  cannot read them.
- Every SQL query uses **parameters** (no string concatenation), which blocks SQL injection.
- All user content is rendered with `textContent`, never `innerHTML`, which blocks XSS.
