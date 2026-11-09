// helpers
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !location.pathname.startsWith('/login')) location.href = '/login';
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// small helper to build elements. strings go in as text so nobody can inject html
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...children.flat().filter(c => c != null && c !== false));
  return el;
}

function timeAgo(sqlTime) {
  const s = (Date.now() - new Date(sqlTime.replace(' ', 'T') + 'Z')) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const avatar = (name, big) => h('span', { class: big ? 'avatar big' : 'avatar', 'aria-hidden': 'true' }, name[0].toUpperCase());

// tiny inline svg icons (h() makes html elements, svg needs its own namespace)
function icon(d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
const heart = 'M12 20s-7-4.4-8.7-8.8C2 7.8 4.1 4.6 7.3 4.6c1.9 0 3.4 1 4.7 2.8 1.3-1.8 2.8-2.8 4.7-2.8 3.2 0 5.3 3.2 4 6.6C19 15.6 12 20 12 20z';
const bubble = 'M4 5h16v11H10l-5 4v-4H4z';
const userLink = name => h('a', { href: `/profile?u=${encodeURIComponent(name)}`, class: 'user' }, '@' + name);

function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3000);
}

// post card
function renderPost(p) {
  const likeBtn = h('button', { type: 'button', class: 'act' + (p.liked_by_me ? ' on' : ''), 'aria-pressed': String(!!p.liked_by_me), 'aria-label': 'Like' },
    icon(heart), h('span', {}, String(p.like_count)));
  const commentBtn = h('button', { type: 'button', class: 'act', 'aria-expanded': 'false', 'aria-label': 'Comments' },
    icon(bubble), h('span', {}, String(p.comment_count)));
  const commentsBox = h('div', { class: 'comments', hidden: true });

  likeBtn.onclick = async () => {
    const r = await api('POST', `/api/posts/${p.id}/like`);
    likeBtn.classList.toggle('on', r.liked);
    likeBtn.setAttribute('aria-pressed', String(r.liked));
    likeBtn.lastChild.textContent = r.like_count;
  };

  commentBtn.onclick = async () => {
    const open = commentsBox.hidden;
    commentsBox.hidden = !open;
    commentBtn.setAttribute('aria-expanded', String(open));
    if (open) loadComments(p, commentsBox, commentBtn);
  };

  const card = h('article', { class: 'post' },
    h('header', {}, avatar(p.username), h('div', { class: 'who' }, userLink(p.username), h('time', {}, timeAgo(p.created_at))),
      !!p.mine && h('button', { type: 'button', class: 'del', onclick: async () => {
        if (!confirm('Delete this post?')) return;
        await api('DELETE', `/api/posts/${p.id}`);
        card.remove();
      } }, 'Delete')),
    h('p', { class: 'body' }, p.body),
    h('footer', {}, likeBtn, commentBtn),
    commentsBox);
  return card;
}

async function loadComments(p, box, counterBtn) {
  const list = h('ul', { class: 'comment-list' });
  const input = h('input', { placeholder: 'Write a comment…', maxlength: 300, 'aria-label': 'Comment' });
  const form = h('form', { class: 'comment-form', onsubmit: async e => {
    e.preventDefault();
    if (!input.value.trim()) return;
    try {
      const c = await api('POST', `/api/posts/${p.id}/comments`, { body: input.value });
      list.append(renderComment(c));
      input.value = '';
      counterBtn.lastChild.textContent = list.children.length;
    } catch (err) { toast(err.message); }
  } }, input, h('button', { class: 'btn btn--small' }, 'Reply'));
  box.replaceChildren(list, form);
  const comments = await api('GET', `/api/posts/${p.id}/comments`);
  list.append(...comments.map(renderComment));
}

const renderComment = c => h('li', {}, userLink(c.username), ' ', h('span', {}, c.body), h('time', {}, timeAgo(c.created_at)));

// pages
async function initNav() {
  const me = await api('GET', '/api/me');
  document.getElementById('me-link').href = `/profile?u=${encodeURIComponent(me.username)}`;
  document.getElementById('logout').onclick = async () => { await api('POST', '/api/logout'); location.href = '/login'; };
  return me;
}

async function feedPage() {
  await initNav();
  const feed = document.getElementById('feed');
  const tabs = document.querySelectorAll('[data-scope]');
  let scope = 'following';

  async function load() {
    const posts = await api('GET', `/api/feed?scope=${scope}`);
    feed.replaceChildren(...(posts.length ? posts.map(renderPost)
      : [h('p', { class: 'empty' }, scope === 'following'
        ? 'Your feed is empty. Follow people or switch to “Everyone”.' : 'No posts yet. Write the first one.')]));
    feed.setAttribute('aria-busy', 'false');
  }
  tabs.forEach(t => t.onclick = () => {
    scope = t.dataset.scope;
    tabs.forEach(x => x.setAttribute('aria-selected', String(x === t)));
    load();
  });

  const form = document.getElementById('composer');
  const textarea = form.querySelector('textarea');
  const counter = form.querySelector('.count');
  textarea.oninput = () => counter.textContent = `${textarea.value.length}/500`;
  form.onsubmit = async e => {
    e.preventDefault();
    try {
      const post = await api('POST', '/api/posts', { body: textarea.value });
      textarea.value = ''; counter.textContent = '0/500';
      document.querySelector('.empty')?.remove();
      feed.prepend(renderPost(post));
    } catch (err) { toast(err.message); }
  };

  const suggest = document.getElementById('suggest');
  const people = await api('GET', '/api/users');
  suggest.replaceChildren(...(people.length ? people.map(u => h('li', {}, avatar(u.username), userLink(u.username),
    h('button', { type: 'button', class: 'btn btn--small', onclick: async e => {
      const r = await api('POST', `/api/users/${encodeURIComponent(u.username)}/follow`);
      e.target.textContent = r.following ? 'Following' : 'Follow';
      load();
    } }, 'Follow'))) : [h('li', { class: 'muted' }, 'You follow everyone here.')]));

  load();
}

async function profilePage() {
  await initNav();
  const name = new URLSearchParams(location.search).get('u') || '';
  const root = document.getElementById('profile');
  let u;
  try { u = await api('GET', `/api/users/${encodeURIComponent(name)}`); }
  catch (err) { root.replaceChildren(h('p', { class: 'empty' }, err.message)); return; }
  document.title = `@${u.username} · Pulse`;
  if (!u.is_me) document.getElementById('me-link').removeAttribute('aria-current');

  const followers = h('dd', {}, String(u.followers));
  const bio = h('p', { class: 'bio' }, u.bio || (u.is_me ? 'Add a short bio about yourself.' : ''));
  let action;
  if (u.is_me) {
    action = h('button', { type: 'button', class: 'btn', onclick: () => {
      const input = h('textarea', { maxlength: 160, rows: 2, 'aria-label': 'Bio' });
      input.value = u.bio;
      const save = h('button', { type: 'button', class: 'btn btn--small btn--primary', onclick: async () => {
        const r = await api('PATCH', '/api/me', { bio: input.value });
        u.bio = r.bio;
        bio.textContent = r.bio || 'Add a short bio about yourself.';
        editor.replaceWith(bio);
      } }, 'Save');
      const editor = h('div', { class: 'bio-edit' }, input, save);
      bio.replaceWith(editor);
      input.focus();
    } }, 'Edit bio');
  } else {
    action = h('button', { type: 'button', class: u.followed_by_me ? 'btn' : 'btn btn--primary' }, u.followed_by_me ? 'Unfollow' : 'Follow');
    action.onclick = async () => {
      const r = await api('POST', `/api/users/${encodeURIComponent(u.username)}/follow`);
      action.textContent = r.following ? 'Unfollow' : 'Follow';
      action.className = r.following ? 'btn' : 'btn btn--primary';
      followers.textContent = r.followers;
    };
  }

  root.replaceChildren(
    h('section', { class: 'profile-head' },
      avatar(u.username, true),
      h('div', { class: 'who' }, h('h1', {}, '@' + u.username), bio,
        h('dl', { class: 'stats' },
          h('div', {}, h('dt', {}, 'posts'), h('dd', {}, String(u.posts.length))),
          h('div', {}, h('dt', {}, 'followers'), followers),
          h('div', {}, h('dt', {}, 'following'), h('dd', {}, String(u.following))))),
      action),
    ...(u.posts.length ? u.posts.map(renderPost) : [h('p', { class: 'empty' }, 'No posts yet.')]));
}

function loginPage() {
  const form = document.getElementById('auth');
  const err = document.getElementById('err');
  let mode = 'login';
  document.querySelectorAll('[data-mode]').forEach(t => t.onclick = () => {
    mode = t.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-selected', String(x === t)));
    form.querySelector('button[type=submit]').textContent = mode === 'login' ? 'Log in' : 'Create account';
    form.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    err.textContent = '';
  });
  form.onsubmit = async e => {
    e.preventDefault();
    try {
      await api('POST', `/api/${mode}`, { username: form.username.value, password: form.password.value });
      location.href = '/';
    } catch (e2) { err.textContent = e2.message; }
  };
}

({ feed: feedPage, profile: profilePage, login: loginPage })[document.body.dataset.page]?.();
