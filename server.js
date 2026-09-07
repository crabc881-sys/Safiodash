// server.js — سيرفر Safio للتعامل مع تسجيل الدخول الحقيقي عبر Discord OAuth2
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();

const {
  CLIENT_ID,
  CLIENT_SECRET,
  BOT_TOKEN,
  REDIRECT_URI,
  SESSION_SECRET,
  MONGODB_URI,
  PORT = 3000
} = process.env;

app.use(session({
  secret: SESSION_SECRET || 'safio-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 6 }
}));

app.use(express.json());
app.use(express.static(path.join(__dirname)));

let mongoClient;
async function getMongo() {
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
  }
  return mongoClient;
}

const AUTOROLES_FILE = path.join(__dirname, 'autoroles-data.json');
function loadAutoroles() {
  try { return JSON.parse(fs.readFileSync(AUTOROLES_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function saveAutorolesData(data) {
  fs.writeFileSync(AUTOROLES_FILE, JSON.stringify(data, null, 2));
}

const ADMINISTRATOR = 0x8;

app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/index.html?error=no_code');

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('فشل الحصول على access_token');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const user = await userRes.json();

    const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const allGuilds = await guildsRes.json();

    const relevantGuilds = allGuilds.filter(g => {
      const perms = BigInt(g.permissions || 0);
      return g.owner === true || (perms & BigInt(ADMINISTRATOR)) === BigInt(ADMINISTRATOR);
    });

    const guildsWithBotStatus = await Promise.all(
      relevantGuilds.map(async (g) => {
        let botInGuild = false;
        try {
          const check = await fetch(`https://discord.com/api/guilds/${g.id}`, {
            headers: { Authorization: `Bot ${BOT_TOKEN}` }
          });
          botInGuild = check.status === 200;
        } catch (e) {
          botInGuild = false;
        }
        return {
          id: g.id,
          name: g.name,
          icon: g.icon
            ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png`
            : null,
          owner: g.owner === true,
          botInGuild
        };
      })
    );

    req.session.user = { id: user.id, username: user.username, avatar: user.avatar };
    req.session.guilds = guildsWithBotStatus;

    res.redirect('/Dashboard.html');
  } catch (err) {
    console.error(err);
    res.redirect('/index.html?error=login_failed');
  }
});

app.get('/api/guilds', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  res.json({ user: req.session.user, guilds: req.session.guilds });
});

app.get('/api/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/index.html'));
});

app.get('/api/guild/:guildId/stats', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const client = await getMongo();
    const credits = client.db('test').collection('credits');
    const { guildId } = req.params;
    const userId = req.session.user.id;

    const userDoc = await credits.findOne({ guildId, userId });
    const balance = userDoc ? userDoc.balance : 0;

    const totalMembers = await credits.countDocuments({ guildId });
    const higherCount = await credits.countDocuments({ guildId, balance: { $gt: balance } });
    const rank = totalMembers > 0 ? higherCount + 1 : null;

    res.json({
      balance,
      level: 1,
      xp: 0,
      xpNeeded: 100,
      rank,
      totalMembers
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'stats_failed' });
  }
});

app.get('/api/guild/:guildId/roles', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const r = await fetch(`https://discord.com/api/guilds/${req.params.guildId}/roles`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    if (!r.ok) return res.status(r.status).json({ error: 'discord_error' });
    const roles = await r.json();
    const filtered = roles
      .filter(role => role.id !== req.params.guildId)
      .sort((a, b) => b.position - a.position)
      .map(role => ({ id: role.id, name: role.name, color: role.color }));
    res.json(filtered);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'roles_failed' });
  }
});

app.get('/api/guild/:guildId/autoroles', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  const all = loadAutoroles();
  res.json(all[req.params.guildId] || { botRoles: [], memberRoles: [] });
});

app.post('/api/guild/:guildId/autoroles', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  const { botRoles, memberRoles } = req.body;
  const all = loadAutoroles();
  all[req.params.guildId] = {
    botRoles: Array.isArray(botRoles) ? botRoles : [],
    memberRoles: Array.isArray(memberRoles) ? memberRoles : []
  };
  saveAutorolesData(all);
  res.json({ success: true });
});

app.get('/api/guild/:guildId/channels', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const r = await fetch(`https://discord.com/api/guilds/${req.params.guildId}/channels`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    if (!r.ok) return res.status(r.status).json({ error: 'discord_error' });
    const channels = await r.json();
    const textChannels = channels
      .filter(c => c.type === 0)
      .sort((a, b) => a.position - b.position)
      .map(c => ({ id: c.id, name: c.name }));
    res.json(textChannels);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'channels_failed' });
  }
});

app.get('/api/guild/:guildId/autoresponders', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const client = await getMongo();
    const col = client.db('test').collection('autoresponders');
    const list = await col.find({ guildId: req.params.guildId }).toArray();
    res.json(list.map(d => ({ ...d, _id: d._id.toString() })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'fetch_failed' });
  }
});

app.post('/api/guild/:guildId/autoresponders', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const { message, reply, enabledRoles, disabledRoles, enabledChannels, disabledChannels } = req.body;
    if (!message || !reply) return res.status(400).json({ error: 'missing_fields' });
    const client = await getMongo();
    const col = client.db('test').collection('autoresponders');
    const doc = {
      guildId: req.params.guildId,
      message: String(message),
      reply: String(reply),
      enabledRoles: Array.isArray(enabledRoles) ? enabledRoles : [],
      disabledRoles: Array.isArray(disabledRoles) ? disabledRoles : [],
      enabledChannels: Array.isArray(enabledChannels) ? enabledChannels : [],
      disabledChannels: Array.isArray(disabledChannels) ? disabledChannels : [],
      createdAt: new Date()
    };
    const result = await col.insertOne(doc);
    res.json({ ...doc, _id: result.insertedId.toString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'create_failed' });
  }
});

app.put('/api/guild/:guildId/autoresponders/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const { message, reply, enabledRoles, disabledRoles, enabledChannels, disabledChannels } = req.body;
    const client = await getMongo();
    const col = client.db('test').collection('autoresponders');
    await col.updateOne(
      { _id: new ObjectId(req.params.id), guildId: req.params.guildId },
      { $set: {
          message: String(message),
          reply: String(reply),
          enabledRoles: Array.isArray(enabledRoles) ? enabledRoles : [],
          disabledRoles: Array.isArray(disabledRoles) ? disabledRoles : [],
          enabledChannels: Array.isArray(enabledChannels) ? enabledChannels : [],
          disabledChannels: Array.isArray(disabledChannels) ? disabledChannels : []
      } }
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'update_failed' });
  }
});

app.delete('/api/guild/:guildId/autoresponders/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const client = await getMongo();
    const col = client.db('test').collection('autoresponders');
    await col.deleteOne({ _id: new ObjectId(req.params.id), guildId: req.params.guildId });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'delete_failed' });
  }
});

app.get('/api/guild/:guildId/autoresponder-status', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const client = await getMongo();
    const col = client.db('test').collection('guildsettings');
    const doc = await col.findOne({ guildId: req.params.guildId });
    res.json({ enabled: doc ? doc.autoresponderEnabled !== false : true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'status_failed' });
  }
});

app.post('/api/guild/:guildId/autoresponder-status', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const { enabled } = req.body;
    const client = await getMongo();
    const col = client.db('test').collection('guildsettings');
    await col.updateOne(
      { guildId: req.params.guildId },
      { $set: { autoresponderEnabled: !!enabled } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'status_update_failed' });
  }
});

// --- Welcome & Leave Settings Routes ---

app.get('/api/guild/:guildId/welcome-settings', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const client = await getMongo();
    const col = client.db('test').collection('welcomesettings');
    const doc = await col.findOne({ guildId: req.params.guildId });
    res.json({
      welcomeEnabled: doc?.welcomeEnabled || false,
      welcomeMessage: doc?.welcomeMessage || '',
      welcomeChannelId: doc?.welcomeChannelId || '',
      leaveEnabled: doc?.leaveEnabled || false,
      leaveMessage: doc?.leaveMessage || '',
      leaveChannelId: doc?.leaveChannelId || ''
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'fetch_failed' });
  }
});

app.post('/api/guild/:guildId/welcome-settings', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const { welcomeEnabled, welcomeMessage, welcomeChannelId, leaveEnabled, leaveMessage, leaveChannelId } = req.body;
    const client = await getMongo();
    const col = client.db('test').collection('welcomesettings');
    await col.updateOne(
      { guildId: req.params.guildId },
      { $set: {
          welcomeEnabled: !!welcomeEnabled,
          welcomeMessage: String(welcomeMessage || ''),
          welcomeChannelId: String(welcomeChannelId || ''),
          leaveEnabled: !!leaveEnabled,
          leaveMessage: String(leaveMessage || ''),
          leaveChannelId: String(leaveChannelId || '')
      } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'update_failed' });
  }
});

// --- General Commands & Status Routes ---

app.get('/api/guild/:guildId/general-status', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const client = await getMongo();
    const col = client.db('test').collection('guildsettings');
    const doc = await col.findOne({ guildId: req.params.guildId });
    res.json({ enabled: doc ? doc.generalEnabled !== false : true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'status_failed' });
  }
});

app.post('/api/guild/:guildId/general-status', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const { enabled } = req.body;
    const client = await getMongo();
    const col = client.db('test').collection('guildsettings');
    await col.updateOne(
      { guildId: req.params.guildId },
      { $set: { generalEnabled: !!enabled } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'status_update_failed' });
  }
});

const GENERAL_COMMANDS_LIST = ['server', 'avatar', 'user', 'safio', 'ping', 'roles'];

app.get('/api/guild/:guildId/general-commands', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const client = await getMongo();
    const col = client.db('test').collection('generalcommands');
    const docs = await col.find({ guildId: req.params.guildId }).toArray();

    const result = GENERAL_COMMANDS_LIST.map(key => {
      const found = docs.find(d => d.commandKey === key);
      return found || {
        commandKey: key,
        enabled: true,
        aliases: [key],
        enabledRoles: [],
        disabledRoles: [],
        enabledChannels: [],
        disabledChannels: []
      };
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'fetch_failed' });
  }
});

app.post('/api/guild/:guildId/general-commands/:commandKey', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  const { commandKey } = req.params;
  if (!GENERAL_COMMANDS_LIST.includes(commandKey)) return res.status(400).json({ error: 'invalid_command' });
  try {
    const { enabled, aliases, enabledRoles, disabledRoles, enabledChannels, disabledChannels } = req.body;
    const client = await getMongo();
    const col = client.db('test').collection('generalcommands');
    await col.updateOne(
      { guildId: req.params.guildId, commandKey },
      { $set: {
          enabled: enabled !== false,
          aliases: Array.isArray(aliases) && aliases.length ? aliases : [commandKey],
          enabledRoles: Array.isArray(enabledRoles) ? enabledRoles : [],
          disabledRoles: Array.isArray(disabledRoles) ? disabledRoles : [],
          enabledChannels: Array.isArray(enabledChannels) ? enabledChannels : [],
          disabledChannels: Array.isArray(disabledChannels) ? disabledChannels : []
      } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'update_failed' });
  }
});

// تشغيل السيرفر
app.listen(PORT, () => console.log(`Safio server running on http://localhost:${PORT}`));
