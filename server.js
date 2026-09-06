// server.js — سيرفر Safio للتعامل مع تسجيل الدخول الحقيقي عبر Discord OAuth2
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();

const {
  CLIENT_ID,
  CLIENT_SECRET,
  BOT_TOKEN,
  REDIRECT_URI,
  SESSION_SECRET,
  PORT = 3000
} = process.env;

app.use(session({
  secret: SESSION_SECRET || 'safio-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 6 }
}));

app.use(express.static(path.join(__dirname)));

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

app.listen(PORT, () => console.log(`Safio server running on http://localhost:${PORT}`));
