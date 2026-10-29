'use strict';

// ---------- state & api ----------

const TOKEN_KEY = 'lumen.token';
const state = { token: readToken(), me: null };
const view = document.getElementById('view');
let renderSeq = 0;

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function saveToken(token) {
  state.token = token;
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

async function api(path, { method = 'GET', form, body, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (state.token) opts.headers.Authorization = 'Bearer ' + state.token;
  if (form) opts.body = new URLSearchParams(form);
  else if (body) opts.body = body;

  const res = await fetch('/api/' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) {
    saveToken(null);
    state.me = null;
    router();
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// ---------- tiny DOM helpers ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 8v8M8 12h8"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" stroke-linecap="round"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20s-7.5-4.6-9.3-9.2C1.4 7.4 3.6 4 7 4c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.4 0 5.6 3.4 4.3 6.8C19.5 15.4 12 20 12 20z"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.1A8.5 8.5 0 1 1 21 12z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="9" cy="9" r="2"/><path d="m21 16-5-5-9 10"/></svg>',
};

function icon(name) {
  const span = h('span');
  span.style.display = 'contents';
  span.innerHTML = ICONS[name]; // trusted constants only
  return span;
}

function mount(...nodes) {
  view.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

function loading() {
  view.replaceChildren(h('div', { class: 'spinner' }));
}

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function avatar(name, size = '') {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const el = h('a', { href: `#/u/${name}`, class: `avatar ${size}`, 'aria-label': name }, name[0]);
  el.style.background = `linear-gradient(135deg, hsl(${hue} 85% 60%), hsl(${(hue + 50) % 360} 80% 50%))`;
  return el;
}

function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  const units = [[604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [secs, label] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      return `${n} ${label}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

// ---------- router ----------

const routes = [
  [/^#\/?$/, renderFeed, 'feed'],
  [/^#\/explore$/, renderExplore, 'explore'],
  [/^#\/new$/, renderNew, 'new'],
  [/^#\/me$/, () => { location.replace(`#/u/${state.me.name}`); }, 'me'],
  [/^#\/u\/([a-z0-9_.]+)$/, renderProfile, 'me'],
  [/^#\/p\/(\d+)$/, renderPost, null],
];

async function router() {
  const tabbar = document.getElementById('tabbar');
  if (!state.token) {
    tabbar.hidden = true;
    return renderAuth();
  }
  if (!state.me) {
    loading();
    try { state.me = await api('me'); } catch { return; }
  }
  tabbar.hidden = false;

  const hash = location.hash || '#/';
  for (const [re, render, tab] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    const isOwnProfile = tab === 'me' && (m[1] === undefined || m[1] === state.me.name);
    for (const a of tabbar.querySelectorAll('a')) {
      a.classList.toggle('active', a.dataset.tab === tab && (tab !== 'me' || isOwnProfile));
    }
    try {
      await render(...m.slice(1));
    } catch (e) {
      mount(h('div', { class: 'empty' }, h('h2', null, 'Hmm.'), h('p', { class: 'muted' }, e.message)));
    }
    return;
  }
  mount(h('div', { class: 'empty' }, h('h2', null, 'Page not found'), h('a', { href: '#/', class: 'link-btn' }, 'Go home')));
}

// ---------- auth ----------

function renderAuth() {
  let mode = 'login';
  const error = h('p', { class: 'error' });
  const username = h('input', { class: 'field', name: 'username', placeholder: 'Username', autocomplete: 'username', autocapitalize: 'none', required: true });
  const password = h('input', { class: 'field', name: 'password', type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
  const submit = h('button', { class: 'btn block' }, 'Log in');
  const toggleText = h('span', { class: 'muted' }, "Don't have an account? ");
  const toggle = h('button', { class: 'link-btn', type: 'button', onclick: () => setMode(mode === 'login' ? 'signup' : 'login') }, 'Sign up');

  function setMode(next) {
    mode = next;
    error.textContent = '';
    submit.textContent = mode === 'login' ? 'Log in' : 'Create account';
    toggleText.textContent = mode === 'login' ? "Don't have an account? " : 'Already have an account? ';
    toggle.textContent = mode === 'login' ? 'Sign up' : 'Log in';
    password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  }

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      error.textContent = '';
      try {
        const res = await api(mode, { method: 'POST', form: { username: username.value, password: password.value } });
        saveToken(res.token);
        state.me = res.user;
        location.hash = '#/';
        router();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        submit.disabled = false;
      }
    },
  }, username, password, error, submit);

  mount(h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
    h('img', { src: '/logo.svg', alt: '', width: 64, height: 64, style: 'margin:0 auto' }),
    h('h1', null, 'Lumen'),
    h('p', { class: 'muted' }, 'Share the moments that light you up.'),
    form,
    h('div', { class: 'small' }, toggleText, toggle),
  )));
  username.focus();
}

async function logout() {
  try { await api('logout', { method: 'POST' }); } catch { /* token may already be gone */ }
  saveToken(null);
  state.me = null;
  location.hash = '#/';
  router();
}

// ---------- post card ----------

function postCard(p, { full = false } = {}) {
  const likeBtn = h('button', { class: 'icon-btn like' + (p.liked ? ' on' : ''), 'aria-label': 'Like', onclick: () => setLike(!p.liked) }, icon('heart'));
  const likes = h('div', { class: 'likes' });
  const burst = h('div', { class: 'burst' }, icon('heart'));
  const comments = h('div', { class: 'comments' });
  const input = h('input', { placeholder: 'Add a comment…', maxlength: 500, 'aria-label': 'Add a comment' });
  const postBtn = h('button', { class: 'link-btn', disabled: true }, 'Post');
  input.addEventListener('input', () => { postBtn.disabled = !input.value.trim(); });

  function draw() {
    likeBtn.classList.toggle('on', p.liked);
    likes.textContent = p.likes ? plural(p.likes, 'like') : 'Be the first to like this';
    const shown = full ? p.comments : p.comments.slice(-2);
    comments.replaceChildren(
      !full && p.comments.length > 2 ? h('a', { href: `#/p/${p.id}`, class: 'muted' }, `View all ${p.comments.length} comments`) : null,
      ...shown.map((c) => h('p', { class: 'comment' }, h('a', { href: `#/u/${c.author}`, class: 'name' }, c.author), ' ', c.text)),
    );
  }

  async function setLike(on) {
    if (on === p.liked) return;
    p.liked = on;
    p.likes += on ? 1 : -1;
    if (on) { likeBtn.classList.remove('pop'); void likeBtn.offsetWidth; likeBtn.classList.add('pop'); }
    draw();
    try {
      Object.assign(p, await api(`posts/${p.id}/like`, { method: on ? 'POST' : 'DELETE' }));
    } catch (e) {
      p.liked = !on;
      p.likes += on ? -1 : 1;
      toast(e.message);
    }
    draw();
  }

  const media = h('div', {
    class: 'media',
    ondblclick: () => {
      burst.classList.remove('go');
      void burst.offsetWidth; // restart the animation
      burst.classList.add('go');
      setLike(true);
    },
  }, h('img', { src: p.image, alt: p.caption || `Photo by ${p.author}`, loading: 'lazy' }), burst);

  const deleteBtn = p.author === state.me.name ? h('button', {
    class: 'icon-btn muted', 'aria-label': 'Delete post',
    onclick: async () => {
      if (!confirm('Delete this post?')) return;
      try {
        await api(`posts/${p.id}`, { method: 'DELETE' });
        card.remove();
        toast('Post deleted');
        if (full) location.hash = `#/u/${state.me.name}`;
      } catch (e) { toast(e.message); }
    },
  }, icon('trash')) : null;

  const form = h('form', {
    class: 'comment-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.disabled = postBtn.disabled = true;
      try {
        Object.assign(p, await api(`posts/${p.id}/comments`, { method: 'POST', form: { text } }));
        input.value = '';
        draw();
      } catch (err) {
        toast(err.message);
      } finally {
        input.disabled = false;
        postBtn.disabled = !input.value.trim();
      }
    },
  }, input, postBtn);

  const card = h('article', { class: 'post' },
    h('div', { class: 'post-head' },
      avatar(p.author),
      h('a', { href: `#/u/${p.author}`, class: 'who' }, p.author),
      deleteBtn),
    media,
    h('div', { class: 'post-body' },
      h('div', { class: 'actions' },
        likeBtn,
        h('button', { class: 'icon-btn', 'aria-label': 'Comment', onclick: () => input.focus() }, icon('comment'))),
      likes,
      p.caption ? h('p', { class: 'caption' }, h('a', { href: `#/u/${p.author}`, class: 'name' }, p.author), ' ', p.caption) : null,
      comments,
      h('a', { href: `#/p/${p.id}`, class: 'time' }, timeAgo(p.at))),
    form);

  draw();
  return card;
}

/** Appends more items as the user scrolls near the bottom. */
function infiniteScroll(container, loadMore) {
  const sentinel = h('div', { class: 'spinner' });
  container.append(sentinel);
  let busy = false;
  const io = new IntersectionObserver(async ([entry]) => {
    if (!entry.isIntersecting || busy) return;
    busy = true;
    try {
      const items = await loadMore();
      if (items.length) sentinel.before(...items);
      else { io.disconnect(); sentinel.remove(); }
    } catch (e) {
      toast(e.message);
    }
    busy = false;
  }, { rootMargin: '600px' });
  io.observe(sentinel);
}

// ---------- feed ----------

function followButton(u, onChange) {
  const btn = h('button', { class: u.followedByMe ? 'btn secondary' : 'btn' }, u.followedByMe ? 'Following' : 'Follow');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      Object.assign(u, await api(`users/${u.name}/follow`, { method: u.followedByMe ? 'DELETE' : 'POST' }));
      btn.className = u.followedByMe ? 'btn secondary' : 'btn';
      btn.textContent = u.followedByMe ? 'Following' : 'Follow';
      onChange?.(u);
    } catch (e) {
      toast(e.message);
    }
    btn.disabled = false;
  });
  return btn;
}

function suggestionStrip(users) {
  return h('section', { class: 'suggest' },
    h('h3', null, 'Suggested for you'),
    h('div', { class: 'suggest-row' }, users.map((u) => h('div', { class: 'suggest-card' },
      avatar(u.name, 'lg'),
      h('a', { href: `#/u/${u.name}`, class: 'name' }, u.name),
      h('span', { class: 'muted small' }, plural(u.followers, 'follower')),
      followButton(u, () => { if (u.followedByMe) renderFeed(); }),
    ))));
}

async function renderFeed() {
  const seq = ++renderSeq;
  loading();
  const [posts, suggestions] = await Promise.all([api('feed'), api('suggestions')]);
  if (seq !== renderSeq) return;

  const list = h('div', { class: 'feed' });
  if (suggestions.length && posts.length < 3) list.append(suggestionStrip(suggestions));
  if (!posts.length) {
    list.append(h('div', { class: 'empty' },
      h('h2', null, 'Welcome to Lumen ✨'),
      h('p', { class: 'muted' }, 'Follow people or share your first photo to fill your feed.'),
      h('a', { href: '#/new', class: 'btn' }, 'Share a photo')));
  }
  list.append(...posts.map((p) => postCard(p)));
  mount(list);

  if (posts.length >= 20) {
    let lastId = posts[posts.length - 1].id;
    infiniteScroll(list, async () => {
      const more = await api(`feed?before=${lastId}`);
      if (more.length) lastId = more[more.length - 1].id;
      return more.map((p) => postCard(p));
    });
  }
}

// ---------- explore ----------

function grid(posts) {
  return h('div', { class: 'grid' }, posts.map((p) => h('a', { href: `#/p/${p.id}`, class: 'tile' },
    h('img', { src: p.image, alt: p.caption || `Photo by ${p.author}`, loading: 'lazy' }),
    h('div', { class: 'stats' }, `♥ ${p.likes}`, `💬 ${p.comments.length}`))));
}

function personRow(u) {
  return h('div', { class: 'person' },
    avatar(u.name),
    h('a', { href: `#/u/${u.name}`, class: 'meta' },
      h('div', { class: 'name' }, u.name),
      h('div', { class: 'muted small' }, plural(u.followers, 'follower'))),
    u.name === state.me.name ? null : followButton(u));
}

async function renderExplore() {
  const seq = ++renderSeq;
  loading();
  const posts = await api('explore');
  if (seq !== renderSeq) return;

  const people = h('div', { class: 'people' });
  const content = h('div', null, posts.length ? grid(posts)
    : h('div', { class: 'empty' }, h('h2', null, 'Nothing here yet'), h('p', { class: 'muted' }, 'Be the first to post something!')));
  let timer;
  const search = h('input', {
    class: 'field', type: 'search', placeholder: 'Search people', 'aria-label': 'Search people',
    oninput: () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = search.value.trim();
        const users = q ? await api(`users?q=${encodeURIComponent(q)}`).catch(() => []) : [];
        if (search.value.trim() !== q) return;
        people.replaceChildren(...users.map(personRow), q && !users.length ? h('p', { class: 'empty muted' }, 'No one found') : '');
        content.hidden = !!q;
      }, 200);
    },
  });
  mount(h('div', { class: 'search' }, search), people, content);
}

// ---------- profile ----------

async function renderProfile(name) {
  const seq = ++renderSeq;
  loading();
  const u = await api(`users/${name}`);
  if (seq !== renderSeq) return;
  const isMe = u.name === state.me.name;

  const followers = h('b', null, u.followers.toLocaleString());
  const bio = h('p', { class: 'bio' }, u.bio || (isMe ? h('span', { class: 'muted' }, 'Add a bio so people know who you are.') : ''));

  function editBio() {
    const area = h('textarea', { class: 'field', maxlength: 150, placeholder: 'Tell people about yourself' });
    area.value = u.bio;
    const editor = h('div', { class: 'bio-editor' }, area, h('div', { class: 'profile-actions' },
      h('button', { class: 'btn secondary', onclick: () => editor.replaceWith(bio) }, 'Cancel'),
      h('button', {
        class: 'btn',
        onclick: async () => {
          try {
            Object.assign(u, await api('me', { method: 'POST', form: { bio: area.value } }));
            state.me = { ...state.me, bio: u.bio };
            bio.replaceChildren(u.bio || h('span', { class: 'muted' }, 'Add a bio so people know who you are.'));
            editor.replaceWith(bio);
          } catch (e) { toast(e.message); }
        },
      }, 'Save')));
    bio.replaceWith(editor);
    area.focus();
  }

  const actions = isMe
    ? [h('button', { class: 'btn secondary', onclick: editBio }, 'Edit bio'), h('button', { class: 'btn secondary', onclick: logout }, 'Log out')]
    : [followButton(u, () => { followers.textContent = u.followers.toLocaleString(); })];

  mount(
    h('section', { class: 'profile' },
      h('div', { class: 'profile-top' },
        avatar(u.name, 'lg ring'),
        h('div', { class: 'counts' },
          h('div', null, h('b', null, u.posts.toLocaleString()), h('span', { class: 'muted small' }, 'posts')),
          h('div', null, followers, h('span', { class: 'muted small' }, 'followers')),
          h('div', null, h('b', null, u.following.toLocaleString()), h('span', { class: 'muted small' }, 'following')))),
      h('h2', null, u.name),
      bio,
      h('div', { class: 'profile-actions' }, actions)),
    u.photos.length ? grid(u.photos) : h('div', { class: 'empty' },
      h('h2', null, 'No posts yet'),
      isMe ? h('a', { href: '#/new', class: 'btn' }, 'Share your first photo') : null),
  );
}

async function renderPost(id) {
  const seq = ++renderSeq;
  loading();
  const p = await api(`posts/${id}`);
  if (seq !== renderSeq) return;
  mount(postCard(p, { full: true }));
}

// ---------- new post ----------

/** Downscales to at most 1440px on the long edge and re-encodes as JPEG, so uploads stay small. */
function prepareImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 1440 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read that image'))), 'image/jpeg', 0.88);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image we can read')); };
    img.src = url;
  });
}

function renderNew() {
  let blob = null;
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const caption = h('textarea', { class: 'field', maxlength: 2200, placeholder: 'Write a caption…' });
  const share = h('button', { class: 'btn block', disabled: true }, 'Share');
  const drop = h('label', { class: 'drop', tabindex: 0 },
    h('div', null, icon('image'), h('p', null, h('b', null, 'Choose a photo')), h('p', { class: 'muted small' }, 'or drag and drop it here')));

  async function pick(file) {
    if (!file) return;
    try {
      blob = await prepareImage(file);
      drop.replaceChildren(h('img', { src: URL.createObjectURL(blob), alt: 'Preview' }));
      share.disabled = false;
    } catch (e) { toast(e.message); }
  }

  drop.addEventListener('click', (e) => { e.preventDefault(); fileInput.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); });
  fileInput.addEventListener('change', () => pick(fileInput.files[0]));

  share.addEventListener('click', async () => {
    share.disabled = true;
    share.textContent = 'Sharing…';
    try {
      const post = await api(`posts?caption=${encodeURIComponent(caption.value)}`, {
        method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg' },
      });
      toast('Shared!');
      location.hash = `#/p/${post.id}`;
    } catch (e) {
      toast(e.message);
      share.disabled = false;
      share.textContent = 'Share';
    }
  });

  mount(h('div', { class: 'composer' }, drop, fileInput, caption, share));
}

// ---------- boot ----------

for (const a of document.querySelectorAll('#tabbar a')) {
  a.append(icon({ feed: 'home', explore: 'search', new: 'plus', me: 'user' }[a.dataset.tab]));
}
window.addEventListener('hashchange', router);
router();
