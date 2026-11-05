const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_FILE = ':memory:';
const app = require('../server');

let server, base;
before(() => new Promise(r => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
after(() => server.close());

// Tiny client that remembers its own session cookie
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', cookie },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
}

test('full social flow: register, post, like, comment, follow, feed', async () => {
  const alice = client(), bob = client();
  assert.equal((await alice('POST', '/api/register', { username: 'alice', password: 'secret1' })).status, 201);
  assert.equal((await bob('POST', '/api/register', { username: 'bob', password: 'secret2' })).status, 201);
  assert.equal((await bob('POST', '/api/register', { username: 'ALICE', password: 'secret2' })).status, 409);
  assert.equal((await client()('POST', '/api/login', { username: 'alice', password: 'nope' })).status, 401);
  assert.equal((await client()('GET', '/api/feed')).status, 401);

  const post = (await alice('POST', '/api/posts', { body: 'Hello world' })).data;
  assert.equal(post.username, 'alice');

  // Bob does not follow Alice yet -> empty following feed, but sees it in "all"
  assert.equal((await bob('GET', '/api/feed')).data.length, 0);
  assert.equal((await bob('GET', '/api/feed?scope=all')).data.length, 1);

  assert.deepEqual((await bob('POST', '/api/users/alice/follow')).data, { following: true, followers: 1 });
  assert.equal((await bob('GET', '/api/feed')).data.length, 1);
  assert.equal((await alice('POST', '/api/users/alice/follow')).status, 400);

  // Like toggles on and off
  assert.deepEqual((await bob('POST', `/api/posts/${post.id}/like`)).data, { liked: true, like_count: 1 });
  assert.deepEqual((await bob('POST', `/api/posts/${post.id}/like`)).data, { liked: false, like_count: 0 });

  await bob('POST', `/api/posts/${post.id}/comments`, { body: 'Nice!' });
  const comments = (await alice('GET', `/api/posts/${post.id}/comments`)).data;
  assert.equal(comments[0].username, 'bob');

  // Only the owner can delete
  assert.equal((await bob('DELETE', `/api/posts/${post.id}`)).status, 404);
  const profile = (await bob('GET', '/api/users/alice')).data;
  assert.equal(profile.followers, 1);
  assert.equal(profile.posts[0].comment_count, 1);
  assert.equal((await alice('DELETE', `/api/posts/${post.id}`)).status, 200);
});
