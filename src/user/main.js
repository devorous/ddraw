/**
 * @fileoverview Standalone user profile page — ddraw.ca/user/<username>.
 *
 * Same visual language and data as the in-app ProfileDialog (src/ui/ProfileDialog.js),
 * rendered as a page instead of a modal so it can be linked/shared/indexed directly.
 */

import { BADGES, badgePickerOptions, effectiveBadgeId } from '../ui/Badges.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const TOKEN_KEY = 'topDrawAuthToken';

// Page chrome + a copy of the ProfileDialog card styles (src/ui/ProfileDialog.js),
// minus the modal backdrop/close-button rules this page doesn't need.
const STYLES = `
:root {
  --role-noble: #ba95ff;
  --role-holy:  #ffa0ae;
  --role-deity: #dd8d4d;
}

html, body {
  margin: 0;
  min-height: 100%;
  background: #0f0f11;
}

.user-page {
  min-height: 100vh;
  font-family: 'Inter', -apple-system, sans-serif;
  color: #e8e2d5;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 1.5rem 1rem 4rem;
}

.user-page-topbar {
  width: 100%;
  max-width: 440px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.25rem;
}
.user-page-brand {
  font-weight: 700;
  font-size: 1.05rem;
  color: #fff;
  text-decoration: none;
  letter-spacing: -0.01em;
}
.user-page-brand:hover { color: #00d4aa; }
.user-page-gallery-link {
  font-size: 0.85rem;
  color: rgba(255,255,255,0.6);
  text-decoration: none;
}
.user-page-gallery-link:hover { color: #fff; }

.user-page-card {
  position: relative;
  background: linear-gradient(180deg, #1c1c1f 0%, #141416 100%);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  max-width: 440px;
  width: 100%;
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(0,0,0,0.5);
  padding: 1.5rem;
  animation: profileFadeIn 0.15s ease;
}

@keyframes profileFadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.profile-dialog-loading,
.profile-dialog-error {
  text-align: center;
  padding: 2rem;
  color: rgba(255,255,255,0.5);
}
.profile-dialog-error { color: #e07070; }

.profile-header {
  display: flex;
  gap: 1rem;
  align-items: center;
}

.profile-avatar-wrap { position: relative; flex-shrink: 0; }

.profile-avatar {
  width: 72px;
  height: 72px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255,255,255,0.1);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  overflow: hidden;
}
.profile-avatar-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.profile-avatar-initial {
  font-size: 2.2rem;
  font-weight: 600;
  color: #fff;
  text-shadow: 0 2px 4px rgba(0,0,0,0.4);
  line-height: 1;
}

.profile-avatar.rank-noble {
  border-color: var(--role-noble);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3),
              0 0 16px color-mix(in srgb, var(--role-noble), transparent 60%);
}
.profile-avatar.rank-holy {
  border-color: var(--role-holy);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3),
              0 0 20px color-mix(in srgb, var(--role-holy), transparent 50%);
}
.profile-avatar.rank-deity {
  border-color: var(--role-deity);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3),
              0 0 24px color-mix(in srgb, var(--role-deity), transparent 35%);
}

.profile-avatar-edit {
  position: absolute;
  bottom: -4px;
  right: -4px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #0c0c0e;
  border: 1px solid rgba(255,255,255,0.2);
  color: #fff;
  font-size: 0.85rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
  box-shadow: 0 2px 6px rgba(0,0,0,0.4);
  transition: background 0.15s, transform 0.15s;
}
.profile-avatar-edit:hover:not(:disabled) {
  background: #1f1f24;
  transform: scale(1.08);
}
.profile-avatar-edit:disabled { opacity: 0.5; cursor: wait; }

.profile-identity { min-width: 0; flex: 1; }

.profile-username {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0;
  letter-spacing: -0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #fff;
}
.profile-username.rank-noble {
  color: var(--role-noble);
  text-shadow: 0 0 8px color-mix(in srgb, var(--role-noble), transparent 60%);
}
.profile-username.rank-holy {
  color: var(--role-holy);
  text-shadow: 0 0 10px color-mix(in srgb, var(--role-holy), transparent 50%);
}
.profile-username.rank-deity {
  color: var(--role-deity);
  text-shadow: 0 0 12px color-mix(in srgb, var(--role-deity), transparent 35%);
  animation: deityShimmer 4s ease-in-out infinite;
}

@keyframes deityShimmer {
  0%, 100% { text-shadow: 0 0 10px color-mix(in srgb, var(--role-deity), transparent 40%); }
  50%      { text-shadow: 0 0 18px color-mix(in srgb, var(--role-deity), transparent 20%); }
}

.profile-role-row {
  margin-top: 0.4rem;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.profile-role-badge {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.7);
  border: 1px solid rgba(255,255,255,0.08);
}
.profile-role-badge.rank-noble {
  color: var(--role-noble);
  background: color-mix(in srgb, var(--role-noble), transparent 85%);
  border-color: color-mix(in srgb, var(--role-noble), transparent 60%);
}
.profile-role-badge.rank-holy {
  color: var(--role-holy);
  background: color-mix(in srgb, var(--role-holy), transparent 85%);
  border-color: color-mix(in srgb, var(--role-holy), transparent 60%);
}
.profile-role-badge.rank-deity {
  color: var(--role-deity);
  background: color-mix(in srgb, var(--role-deity), transparent 80%);
  border-color: color-mix(in srgb, var(--role-deity), transparent 50%);
}

.profile-meta { font-size: 0.78rem; color: rgba(255,255,255,0.4); }

.profile-stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.5rem;
  margin-top: 1.25rem;
}
.profile-stat {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.05);
  border-radius: 8px;
  padding: 0.75rem 0.5rem;
  text-align: center;
  transition: background 0.15s, border-color 0.15s;
}
.profile-stat:hover {
  background: rgba(255,255,255,0.06);
  border-color: rgba(255,255,255,0.1);
}
.profile-stat-value {
  font-size: 1rem;
  font-weight: 600;
  color: #fff;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.profile-stat-label {
  font-size: 0.65rem;
  color: rgba(255,255,255,0.45);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-top: 0.35rem;
}

.profile-recent { margin-top: 1.5rem; }
.profile-recent-title {
  font-size: 0.72rem;
  color: rgba(255,255,255,0.4);
  margin-bottom: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.profile-recent-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.5rem;
}
.profile-recent-item {
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: 6px;
  background: #121212;
  border: 1px solid rgba(255,255,255,0.04);
  padding: 0;
  cursor: pointer;
}
.profile-recent-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.2s;
}
.profile-recent-item:hover img { transform: scale(1.05); }
.profile-recent-empty {
  grid-column: 1 / -1;
  text-align: center;
  padding: 1rem;
  color: rgba(255,255,255,0.3);
  font-size: 0.82rem;
}

.profile-actions {
  margin-top: 1.25rem;
  display: flex;
  gap: 0.75rem;
}
.profile-btn {
  flex: 1;
  padding: 0.7rem 1rem;
  border: 1px solid rgba(255,255,255,0.08);
  background: none;
  color: rgba(255,255,255,0.6);
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 500;
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s, background 0.2s;
  text-decoration: none;
  text-align: center;
  display: block;
}
.profile-btn:hover {
  border-color: rgba(255,255,255,0.2);
  color: #fff;
}
.profile-btn-primary {
  background: #00d4aa;
  border-color: #00d4aa;
  color: #121212;
}
.profile-btn-primary:hover {
  background: #00f0c3;
  border-color: #00f0c3;
}

.profile-avatar-remove {
  margin-top: 0.4rem;
  background: none;
  border: none;
  color: rgba(224,112,112,0.85);
  font-size: 0.72rem;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
  text-decoration-color: rgba(224,112,112,0.3);
}
.profile-avatar-remove:hover { color: #ff8585; }
.profile-avatar-remove:disabled { opacity: 0.5; cursor: wait; }

.profile-edit-error {
  margin-top: 0.75rem;
  font-size: 0.75rem;
  color: #e07070;
  text-align: center;
}

.profile-username-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}
.profile-username-row .profile-username { min-width: 0; }

.profile-badge-img,
.profile-badge-svg {
  width: 20px;
  height: 20px;
  display: block;
  flex: 0 0 20px;
}
.profile-badge-svg svg { width: 100%; height: 100%; display: block; }
.profile-badge-current {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.profile-badge-noicon {
  width: 14px;
  height: 2px;
  border-radius: 1px;
  background: rgba(255,255,255,0.55);
  display: block;
}

.profile-badge-picker { position: relative; flex: 0 0 auto; }
.profile-badge-trigger {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 5px;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.04);
  color: #fff;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.profile-badge-trigger:hover:not(:disabled) {
  border-color: rgba(255,255,255,0.25);
  background: rgba(255,255,255,0.07);
}
.profile-badge-trigger:disabled { opacity: 0.5; cursor: wait; }
.profile-badge-caret {
  font-size: 0.6rem;
  color: rgba(255,255,255,0.5);
  line-height: 1;
}
.profile-badge-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 5;
  display: flex;
  gap: 2px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.12);
  background: #1c1c1f;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.profile-badge-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 6px;
  border: 1px solid transparent;
  background: none;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.profile-badge-option:hover { background: rgba(255,255,255,0.08); }
.profile-badge-option.selected {
  border-color: #00d4aa;
  background: rgba(0,212,170,0.12);
}

.profile-status {
  margin-top: 1rem;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.05);
  border-radius: 8px;
  padding: 0.7rem 0.85rem;
}
.profile-status-text {
  flex: 1;
  min-width: 0;
  font-size: 0.85rem;
  line-height: 1.4;
  color: rgba(255,255,255,0.85);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.profile-status.clickable {
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.profile-status.clickable:hover {
  background: rgba(255,255,255,0.06);
  border-color: rgba(255,255,255,0.12);
}

.profile-status-quick { margin-top: 1rem; }
.profile-status-quick input {
  width: 100%;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  color: #fff;
  font: inherit;
  font-size: 0.85rem;
  padding: 0.6rem 0.85rem;
  box-sizing: border-box;
  transition: border-color 0.15s, background 0.15s;
}
.profile-status-quick input::placeholder { color: rgba(255,255,255,0.4); }
.profile-status-quick input:focus {
  outline: none;
  border-color: rgba(0, 212, 170, 0.5);
  background: rgba(255,255,255,0.05);
}

.profile-status-editor {
  margin-top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.profile-status-editor textarea {
  width: 100%;
  min-height: 60px;
  max-height: 120px;
  resize: vertical;
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  color: #fff;
  font: inherit;
  font-size: 0.85rem;
  padding: 0.6rem 0.75rem;
  box-sizing: border-box;
}
.profile-status-editor textarea:focus {
  outline: none;
  border-color: #00d4aa;
  box-shadow: 0 0 0 1px rgba(0, 212, 170, 0.4);
}
.profile-status-editor-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.72rem;
  color: rgba(255,255,255,0.45);
}
.profile-status-editor-actions { display: flex; gap: 0.5rem; }
.profile-status-editor-actions button {
  background: none;
  border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.7);
  cursor: pointer;
  font: inherit;
  font-size: 0.78rem;
  padding: 0.4rem 0.8rem;
  border-radius: 4px;
  transition: all 0.15s;
}
.profile-status-editor-actions button.primary {
  border-color: #00d4aa;
  color: #00d4aa;
  background: rgba(0, 212, 170, 0.1);
}
.profile-status-editor-actions button.primary:hover:not(:disabled) {
  background: #00d4aa;
  color: #121212;
}
.profile-status-editor-actions button:disabled { opacity: 0.5; cursor: default; }
`;

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);
}

const PX_PER_METER = 3779;
const ROLE_NAMES = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble Mod', 'Holy Mod', 'Deity Mod'];
const AVATAR_TARGET_PX = 256;
const AVATAR_QUALITY = 0.82;
const STATUS_MAX = 140;

function rankClass(role) {
  if (role >= 9) return 'rank-deity';
  if (role >= 8) return 'rank-holy';
  if (role >= 7) return 'rank-noble';
  if (role >= 5) return 'rank-admin';
  if (role >= 4) return 'rank-mod';
  if (role >= 3) return 'rank-helper';
  if (role >= 2) return 'rank-trusted';
  if (role >= 1) return 'rank-user';
  return 'rank-guest';
}

function roleName(role) {
  return ROLE_NAMES[Math.max(0, Math.min(9, role | 0))] || 'User';
}

function avatarInitial(name) {
  if (!name) return '?';
  return [...name][0].toUpperCase();
}

function avatarHue(name) {
  if (!name) return 200;
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

function formatMeters(px) {
  const m = (px || 0) / PX_PER_METER;
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  if (m >= 1) return `${m.toFixed(1)} m`;
  return `${(m * 100).toFixed(0)} cm`;
}

function formatTime(ms) {
  const totalMin = Math.floor((ms || 0) / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

function formatNumber(n) { return (n || 0).toLocaleString(); }

function formatJoinDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function getAuthToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; }
  catch { return ''; }
}

function usernameFromPath() {
  const m = window.location.pathname.match(/^\/user\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : '';
}

function resizeImageToDataUrl(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = maxSize;
      canvas.height = maxSize;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, side, side, 0, 0, maxSize, maxSize);
      try { resolve(canvas.toDataURL('image/jpeg', quality)); }
      catch (err) { reject(err); }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not load image'));
    };
    img.src = url;
  });
}

class UserPage {
  constructor(root) {
    this.root = root;
    this._data = null;
    this._username = '';
    this._savingAvatar = false;
    this._savingBadge = false;
    this._badgeMenuOpen = false;
    this._editError = '';
    this._editingStatus = false;
    this._statusDraft = '';
    this._savingStatus = false;
    this._boundBadgeOutside = this._handleBadgeOutside.bind(this);
    document.addEventListener('mousedown', this._boundBadgeOutside);
  }

  async load() {
    this._username = usernameFromPath();
    if (!this._username) {
      this._renderMessage('No username given.');
      return;
    }
    this._renderLoading();
    try {
      const token = getAuthToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`${API_BASE}/api/users/${encodeURIComponent(this._username)}`, { headers });
      const data = await res.json();
      if (!res.ok) {
        this._renderMessage(data.error || 'User not found', true);
        return;
      }
      this._data = data;
      document.title = `${data.username} — DDraw`;
      this._renderProfile();
    } catch {
      this._renderMessage('Connection error', true);
    }
  }

  _shell(inner) {
    this.root.innerHTML = `
      <div class="user-page">
        <div class="user-page-topbar">
          <a class="user-page-brand" href="/">DDraw</a>
          <a class="user-page-gallery-link" href="/gallery">Gallery</a>
        </div>
        <div class="user-page-card">${inner}</div>
      </div>
    `;
  }

  _renderLoading() {
    this._shell(`<div class="profile-dialog-loading">Loading...</div>`);
  }

  _renderMessage(message, isError = false) {
    this._shell(`<div class="profile-dialog-${isError ? 'error' : 'loading'}">${escapeHtml(message)}</div>`);
  }

  _buildGalleryUrl(pathSegment) {
    return `/gallery/${encodeURIComponent(pathSegment)}`;
  }

  _renderProfile() {
    const data = this._data;
    const role = data.role || 1;
    const rcls = rankClass(role);
    const hue = avatarHue(data.username);
    const initial = escapeHtml(avatarInitial(data.username));
    const isOwn = !!data.isOwn;

    const joinMeta = data.createdAt
      ? `<span class="profile-meta">Joined ${formatJoinDate(data.createdAt)}</span>`
      : '';

    this._recentUploads = data.recentUploads;

    const recentHtml = data.recentUploads.length > 0
      ? data.recentUploads.map((item, idx) => `
          <button class="profile-recent-item" data-index="${idx}" title="${escapeHtml(item.title || 'View')}">
            <img src="${item.thumbUrl}" alt="${escapeHtml(item.title || 'artwork')}" loading="lazy">
          </button>
        `).join('')
      : '<div class="profile-recent-empty">No uploads yet</div>';

    const streakStat = (data.consecutiveDaysDrawn || 0) > 0
      ? `<div class="profile-stat">
           <div class="profile-stat-value">${formatNumber(data.consecutiveDaysDrawn)}</div>
           <div class="profile-stat-label">Day Streak</div>
         </div>`
      : '';

    const avatarBg = `background: linear-gradient(135deg, hsl(${hue}, 65%, 48%) 0%, hsl(${(hue + 35) % 360}, 70%, 35%) 100%);`;
    const avatarInner = data.avatar
      ? `<img class="profile-avatar-img" src="${data.avatar}" alt="avatar">`
      : `<span class="profile-avatar-initial">${initial}</span>`;

    const avatarEditBtn = isOwn
      ? `<button class="profile-avatar-edit" data-action="edit-avatar" title="Change avatar" aria-label="Change avatar"${this._savingAvatar ? ' disabled' : ''}>${this._savingAvatar ? '…' : '✎'}</button>
         <input type="file" data-input="avatar" accept="image/*" style="display:none">`
      : '';

    const removeAvatarBtn = (isOwn && data.avatar)
      ? `<button class="profile-avatar-remove" data-action="remove-avatar"${this._savingAvatar ? ' disabled' : ''}>Remove avatar</button>`
      : '';

    const errHtml = this._editError
      ? `<div class="profile-edit-error">${escapeHtml(this._editError)}</div>`
      : '';

    const currentBadgeId = effectiveBadgeId(data);
    const badgeIcon = (id) => {
      const def = BADGES[id];
      if (!def) return '';
      return def.img
        ? `<img class="profile-badge-img" src="${def.img}" alt="${escapeHtml(def.label)}" draggable="false">`
        : `<span class="profile-badge-svg" style="color:${def.color || 'currentColor'}">${def.svg}</span>`;
    };
    const noIcon = '<span class="profile-badge-noicon"></span>';
    let badgeHtml = '';
    if (isOwn) {
      const optionBtn = (id, selected, inner, label) =>
        `<button type="button" class="profile-badge-option${selected ? ' selected' : ''}" data-badge="${id}" title="${escapeHtml(label)}" role="option" aria-selected="${selected}">${inner}</button>`;
      const menuItems = [optionBtn('none', !currentBadgeId, noIcon, 'No badge')]
        .concat(badgePickerOptions(data).map((b) =>
          optionBtn(b.id, b.id === currentBadgeId, badgeIcon(b.id), b.label)))
        .join('');
      const menuHtml = this._badgeMenuOpen
        ? `<div class="profile-badge-menu" role="listbox">${menuItems}</div>`
        : '';
      badgeHtml = `
        <span class="profile-badge-picker">
          <button type="button" class="profile-badge-trigger" data-action="toggle-badge-menu" title="Choose your badge" aria-haspopup="listbox" aria-expanded="${!!this._badgeMenuOpen}"${this._savingBadge ? ' disabled' : ''}>
            ${currentBadgeId && BADGES[currentBadgeId] ? badgeIcon(currentBadgeId) : noIcon}
            <span class="profile-badge-caret">▾</span>
          </button>
          ${menuHtml}
        </span>`;
    } else if (currentBadgeId && BADGES[currentBadgeId]) {
      badgeHtml = `<span class="profile-badge-current" title="${escapeHtml(BADGES[currentBadgeId].label)}">${badgeIcon(currentBadgeId)}</span>`;
    }

    const status = (data.status || '').trim();
    let statusHtml = '';
    if (this._editingStatus && isOwn) {
      const remaining = STATUS_MAX - (this._statusDraft || '').length;
      statusHtml = `
        <div class="profile-status-editor">
          <textarea data-input="status" maxlength="${STATUS_MAX}" placeholder="Add a status or short blurb...">${escapeHtml(this._statusDraft)}</textarea>
          <div class="profile-status-editor-row">
            <span>${remaining} left</span>
            <div class="profile-status-editor-actions">
              <button data-action="cancel-status"${this._savingStatus ? ' disabled' : ''}>Cancel</button>
              <button class="primary" data-action="save-status"${this._savingStatus ? ' disabled' : ''}>${this._savingStatus ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>`;
    } else if (status) {
      const clickable = isOwn ? ' clickable' : '';
      const action = isOwn ? ' data-action="edit-status"' : '';
      const roleAttr = isOwn ? ' role="button" tabindex="0"' : '';
      statusHtml = `
        <div class="profile-status${clickable}"${action}${roleAttr}>
          <div class="profile-status-text">${escapeHtml(status)}</div>
        </div>`;
    } else if (isOwn) {
      statusHtml = `
        <div class="profile-status-quick">
          <input type="text" data-input="status-quick" maxlength="${STATUS_MAX}" placeholder="Add a status...">
        </div>`;
    }

    this._shell(`
      <div class="profile-header">
        <div class="profile-avatar-wrap">
          <div class="profile-avatar ${rcls}" style="${avatarBg}">${avatarInner}</div>
          ${avatarEditBtn}
        </div>
        <div class="profile-identity">
          <div class="profile-username-row">
            <h1 class="profile-username ${rcls}">${escapeHtml(data.username)}</h1>
            ${badgeHtml}
          </div>
          <div class="profile-role-row">
            <span class="profile-role-badge ${rcls}">${roleName(role)}</span>
            ${joinMeta}
          </div>
          ${removeAvatarBtn}
        </div>
      </div>

      ${errHtml}

      ${statusHtml}

      <div class="profile-stats-grid">
        <div class="profile-stat">
          <div class="profile-stat-value">${formatMeters(data.distanceDrawn)}</div>
          <div class="profile-stat-label">Distance Drawn</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${formatTime(data.timeSpentMs)}</div>
          <div class="profile-stat-label">Time Drawing</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${formatNumber(data.totalStrokes)}</div>
          <div class="profile-stat-label">Strokes</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${formatNumber(data.uploadCount)}</div>
          <div class="profile-stat-label">Uploads</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${formatNumber(data.totalLikes)}</div>
          <div class="profile-stat-label">Likes</div>
        </div>
        ${streakStat}
      </div>

      <div class="profile-recent">
        <div class="profile-recent-title">Recent Uploads</div>
        <div class="profile-recent-grid">${recentHtml}</div>
      </div>

      <div class="profile-actions">
        <a href="${this._buildGalleryUrl(data.username)}" class="profile-btn profile-btn-primary">
          View All Art
        </a>
      </div>
    `);

    const body = this.root;
    body.querySelectorAll('.profile-recent-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        const item = this._recentUploads[idx];
        if (item) window.open(this._buildGalleryUrl(item.id), '_blank');
      });
    });

    this._wireEditing(body);
  }

  _wireEditing(root) {
    const editAvatar = root.querySelector('[data-action="edit-avatar"]');
    const fileInput = root.querySelector('[data-input="avatar"]');
    if (editAvatar && fileInput) {
      editAvatar.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => this._handleAvatarFile(e));
    }

    const removeAvatar = root.querySelector('[data-action="remove-avatar"]');
    if (removeAvatar) removeAvatar.addEventListener('click', () => this._removeAvatar());

    const badgeToggle = root.querySelector('[data-action="toggle-badge-menu"]');
    if (badgeToggle) {
      badgeToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this._savingBadge) return;
        this._badgeMenuOpen = !this._badgeMenuOpen;
        this._renderProfile();
      });
    }
    root.querySelectorAll('.profile-badge-option').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._badgeMenuOpen = false;
        this._saveBadge(btn.dataset.badge || 'none');
      });
    });

    const editStatus = root.querySelector('[data-action="edit-status"]');
    if (editStatus) {
      editStatus.addEventListener('click', () => this._beginStatusEdit());
      editStatus.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._beginStatusEdit();
        }
      });
    }

    const cancelStatus = root.querySelector('[data-action="cancel-status"]');
    if (cancelStatus) cancelStatus.addEventListener('click', () => this._cancelStatusEdit());

    const saveStatus = root.querySelector('[data-action="save-status"]');
    if (saveStatus) saveStatus.addEventListener('click', () => this._saveStatus());

    const quickInput = root.querySelector('[data-input="status-quick"]');
    if (quickInput) {
      const expand = () => {
        this._statusDraft = quickInput.value;
        this._editingStatus = true;
        this._renderProfile();
      };
      quickInput.addEventListener('focus', expand);
      quickInput.addEventListener('input', expand);
    }

    const statusInput = root.querySelector('[data-input="status"]');
    if (statusInput) {
      statusInput.addEventListener('input', (e) => {
        this._statusDraft = e.target.value;
        const row = root.querySelector('.profile-status-editor-row span');
        if (row) row.textContent = `${STATUS_MAX - this._statusDraft.length} left`;
      });
      statusInput.focus();
      const len = statusInput.value.length;
      statusInput.setSelectionRange(len, len);
    }
  }

  _beginStatusEdit() {
    this._statusDraft = this._data?.status || '';
    this._editingStatus = true;
    this._editError = '';
    this._renderProfile();
  }

  _cancelStatusEdit() {
    this._editingStatus = false;
    this._statusDraft = '';
    this._editError = '';
    this._renderProfile();
  }

  async _saveStatus() {
    if (this._savingStatus) return;
    this._savingStatus = true;
    this._editError = '';
    this._renderProfile();
    try {
      const updated = await this._patchProfile({ status: this._statusDraft });
      this._data.status = updated.status ?? this._statusDraft.trim();
      this._editingStatus = false;
      this._statusDraft = '';
    } catch (err) {
      this._editError = err?.message || 'Failed to save status';
    } finally {
      this._savingStatus = false;
      this._renderProfile();
    }
  }

  async _handleAvatarFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this._editError = 'Select an image file';
      this._renderProfile();
      return;
    }
    if (this._savingAvatar) return;
    this._savingAvatar = true;
    this._editError = '';
    this._renderProfile();
    try {
      const dataUrl = await resizeImageToDataUrl(file, AVATAR_TARGET_PX, AVATAR_QUALITY);
      const updated = await this._patchProfile({ avatar: dataUrl });
      this._data.avatar = updated.avatar ?? dataUrl;
    } catch (err) {
      this._editError = err?.message || 'Failed to upload';
    } finally {
      this._savingAvatar = false;
      this._renderProfile();
    }
  }

  async _saveBadge(badgeId) {
    if (this._savingBadge) return;
    this._savingBadge = true;
    this._editError = '';
    this._renderProfile();
    try {
      const updated = await this._patchProfile({ selectedBadge: badgeId });
      this._data.selectedBadge = updated.selectedBadge ?? badgeId;
    } catch (err) {
      this._editError = err?.message || 'Failed to save badge';
    } finally {
      this._savingBadge = false;
      this._renderProfile();
    }
  }

  async _removeAvatar() {
    if (this._savingAvatar) return;
    this._savingAvatar = true;
    this._editError = '';
    this._renderProfile();
    try {
      await this._patchProfile({ avatar: null });
      this._data.avatar = null;
    } catch (err) {
      this._editError = err?.message || 'Failed to remove';
    } finally {
      this._savingAvatar = false;
      this._renderProfile();
    }
  }

  async _patchProfile(body) {
    const token = getAuthToken();
    if (!token) throw new Error('Not signed in');
    const res = await fetch(`${API_BASE}/api/users/me/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Save failed');
    return json;
  }

  _handleBadgeOutside(e) {
    if (!this._badgeMenuOpen) return;
    if (e.target.closest?.('.profile-badge-picker')) return;
    this._badgeMenuOpen = false;
    this._renderProfile();
  }
}

injectStyles();
const page = new UserPage(document.getElementById('app'));
page.load();
