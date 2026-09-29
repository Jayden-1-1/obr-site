const path = require('path');
const fs = require('fs');
const { db, posToRole, UPLOAD_DIR } = require('../db');
const { getUser } = require('../middleware/auth');
const discord = require('../discord');

function currentCommander() {
  return db.prepare("SELECT * FROM users WHERE role = 'commander' LIMIT 1").get() || null;
}

function roleForPosition(position) {
  if (position !== 'Командир О.Б.Р') return posToRole(position);
  return currentCommander() ? 'zam' : 'commander';
}

function positionAllowedFor(position, userId) {
  if (position !== 'Командир О.Б.Р') return true;
  if (!userId) return true;
  const cmdr = currentCommander();
  return !cmdr || cmdr.id === userId;
}

function nextEmployeeNumber() {
  const row = db
    .prepare('SELECT MAX(CAST(employee_number AS INTEGER)) AS m FROM roster')
    .get();
  let n = (row.m || 0) + 1;
  while (db.prepare('SELECT id FROM roster WHERE employee_number = ?').get(String(n))) n++;
  return String(n);
}

function ensureCommanderInRoster() {
  const cmdr = currentCommander();
  if (!cmdr) return;
  const row = db.prepare('SELECT * FROM roster WHERE user_id = ?').get(cmdr.id);
  if (row) {
    let changed = false;
    if (row.position !== 'Командир О.Б.Р') {
      db.prepare("UPDATE roster SET position = 'Командир О.Б.Р' WHERE id = ?").run(row.id);
      changed = true;
    }
    if (row.status !== 'active') {
      db.prepare("UPDATE roster SET status = 'active' WHERE id = ?").run(row.id);
      changed = true;
    }
    if (changed) {
      console.log(`[roster] Командир ${cmdr.username} синхронизирован в штатке как «Командир О.Б.Р».`);
    }
    return;
  }
  db.prepare(
    "INSERT INTO roster (employee_number, callsign, rank, position, status, user_id) VALUES (?, ?, 'Полковник', 'Командир О.Б.Р', 'active', ?)"
  ).run(nextEmployeeNumber(), cmdr.username, cmdr.id);
  console.log(`[roster] Командир ${cmdr.username} автоматически внесён в штат как «Командир О.Б.Р».`);
}

function syncUserRole(userId, position, isActive) {
  const target = getUser(userId);
  if (!target) return;
  if (target.role === 'commander') return;
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(
    isActive ? roleForPosition(position) : 'user',
    target.id
  );
}

function memberMention(userId) {
  const t = userId ? getUser(userId) : null;
  return t && t.discord_id ? `<@${t.discord_id}>` : '';
}

function toISODate(s) {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = String(s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function vacationActive(entry) {
  const iso = toISODate(entry.vacation_until);
  return !!iso && iso >= todayISO();
}

function validUntilDate(s) {
  if (!s) return false;
  let day, month, year;
  let m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (m) {
    day = +m[1];
    month = +m[2] - 1;
    year = +m[3];
  } else {
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) {
      year = +m[1];
      month = +m[2] - 1;
      day = +m[3];
    } else {
      return false;
    }
  }
  const d = new Date(year, month, day);
  if (d.getDate() !== day || d.getMonth() !== month || d.getFullYear() !== year) return false;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return d >= now;
}

function desiredRolesForEntry(entry) {
  const cfg = discord.loadConfig();
  const set = new Set();
  const add = (v) => {
    for (const r of discord.parseRoles(v)) set.add(r);
  };
  add(cfg.role_on_accept);
  const map = cfg.role_map || {};
  add((map.rank || {})[entry.rank]);
  add((map.position || {})[entry.position]);
  for (const g of map.rank_groups || []) {
    if ((g.ranks || []).includes(entry.rank)) add(g.roles);
  }
  for (const g of map.position_groups || []) {
    if ((g.positions || []).includes(entry.position)) add(g.roles);
  }
  add((map.warnings || {})[String(entry.warnings)]);
  if (vacationActive(entry)) add(map.vacation);
  if (entry.builder) add(cfg.role_builder);
  return [...set];
}

function syncMemberDiscordRoles(userId, entry) {
  const target = userId ? getUser(userId) : null;
  if (!target || !target.discord_id) return;
  discord.syncRoles(target.discord_id, desiredRolesForEntry(entry).join(','));
}

function discordOnAccept(entry, employeeNumber) {
  const target = getUser(entry.user_id);
  const mention = memberMention(entry.user_id);
  if (target && target.discord_id) {
    discord.syncRoles(target.discord_id, desiredRolesForEntry(entry).join(','));
    discord.sendDM(
      target.discord_id,
      `Поздравляем, **${target.discord_username || target.username}**! Вы приняты в О.Б.Р.\nДолжность: ${entry.position}\nНомер: ${employeeNumber}`
    );
  }
  discord.log({
    title: 'Заявка принята',
    description: `**${target ? target.username : entry.callsign}** принят в состав фракции.`,
    fields: [
      { name: 'Позывной', value: entry.callsign || (target ? target.username : '—'), inline: true },
      { name: 'Должность', value: entry.position, inline: true },
      { name: 'Номер', value: employeeNumber, inline: true },
    ],
    color: discord.COLOR_GREEN,
    mention,
  });
}

function discordOnDismissal(userId, callsign, reason, title = 'Увольнение') {
  const target = userId ? getUser(userId) : null;
  const mention = memberMention(userId);
  if (target && target.discord_id) {
    discord.resetRoles(target.discord_id);
    discord.sendDM(target.discord_id, `Уведомление из О.Б.Р:\n${reason}`);
  }
  discord.log({
    title,
    description: reason,
    fields: [{ name: 'Сотрудник', value: callsign || (target ? target.username : '—'), inline: true }],
    color: discord.COLOR_RED,
    mention,
  });
}

function discordOnWarning(userId, callsign, title, description) {
  const target = userId ? getUser(userId) : null;
  const mention = memberMention(userId);
  if (target && target.discord_id) {
    discord.sendDM(target.discord_id, `Уведомление из О.Б.Р:\n${title}\n${description}`);
  }
  discord.log({
    channel: 'warnings',
    title,
    description,
    fields: [{ name: 'Сотрудник', value: callsign || '—', inline: true }],
    color: discord.COLOR_YELLOW,
    mention,
  });
}

function discordOnVacation(userId, callsign, title, description) {
  const target = userId ? getUser(userId) : null;
  const mention = memberMention(userId);
  if (target && target.discord_id) {
    discord.sendDM(target.discord_id, `Уведомление из О.Б.Р:\n${title}\n${description}`);
  }
  discord.log({
    title,
    description,
    fields: [{ name: 'Сотрудник', value: callsign || '—', inline: true }],
    color: discord.COLOR_BLUE,
    mention,
  });
}

function cleanupUploaded(photos) {
  for (const p of photos || []) {
    const sn = path.basename(String(p.stored_name || ''));
    if (/^[a-zA-Z0-9._-]+$/.test(sn)) {
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, sn));
      } catch (_) {}
    }
  }
}

function cleanExpiredPunishments() {
  const now = todayISO();
  const activePuns = db
    .prepare("SELECT * FROM punishments WHERE status = 'active' AND until_date != ''")
    .all();

  const expired = activePuns.filter((p) => {
    const iso = toISODate(p.until_date);
    return iso && iso < now;
  });

  for (const p of expired) {
    db.prepare(
      `UPDATE punishments 
       SET status = 'expired', 
           removed_at = datetime('now', 'localtime'), 
           remove_reason = 'Время выговора истекло', 
           removed_by = 'Система' 
       WHERE id = ?`
    ).run(p.id);

    if (p.roster_id) {
      db.prepare('UPDATE roster SET warnings = MAX(warnings - 1, 0) WHERE id = ?').run(p.roster_id);
      const entry = db.prepare('SELECT * FROM roster WHERE id = ?').get(p.roster_id);
      if (entry) {
        syncMemberDiscordRoles(entry.user_id, entry);
        discordOnWarning(
          entry.user_id,
          p.callsign,
          'Выговор снят (автоматически)',
          `**Причина снятия:** Время выговора истекло\n**Срок действия был до:** ${p.until_date}\n**За что выносился:** ${p.reason || '—'}`
        );
      }
    }
  }

  if (expired.length) {
    console.log(`[PUNISHMENTS] Истёкшие выговоры сняты: ${expired.length}`);
  }
  return expired.length;
}

module.exports = {
  currentCommander,
  roleForPosition,
  positionAllowedFor,
  nextEmployeeNumber,
  ensureCommanderInRoster,
  syncUserRole,
  memberMention,
  toISODate,
  todayISO,
  vacationActive,
  validUntilDate,
  desiredRolesForEntry,
  syncMemberDiscordRoles,
  discordOnAccept,
  discordOnDismissal,
  discordOnWarning,
  discordOnVacation,
  cleanExpiredPunishments,
  cleanupUploaded,
};
