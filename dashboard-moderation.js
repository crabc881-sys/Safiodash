// dashboard-moderation.js
// أوامر الإشراف المتحكم فيها من داشبورد Safio

const mongoose = require('mongoose');
const { EmbedBuilder, PermissionsBitField } = require('discord.js');

const BRAND_COLOR = 0xF4B400;

async function getDb() {
    return mongoose.connection.db;
}

function checkPermissions(cmd, member, channelId) {
    const memberRoleIds = member.roles.cache.map(r => r.id);
    if (cmd.disabledRoles?.length && cmd.disabledRoles.some(r => memberRoleIds.includes(r))) return false;
    if (cmd.enabledRoles?.length && !cmd.enabledRoles.some(r => memberRoleIds.includes(r))) return false;
    if (cmd.disabledChannels?.length && cmd.disabledChannels.includes(channelId)) return false;
    if (cmd.enabledChannels?.length && !cmd.enabledChannels.includes(channelId)) return false;
    return true;
}

function parseDuration(str) {
    if (!str) return null;
    const match = str.match(/^(\d+)(s|m|h|d)$/i);
    if (!match) return null;
    const num = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return num * multipliers[unit];
}

async function reply(message, text) {
    const embed = new EmbedBuilder().setColor(BRAND_COLOR).setDescription(text);
    await message.channel.send({ embeds: [embed] });
}

async function handleMessage(message, client) {
    if (message.author.bot) return;
    if (!message.guild) return;

    try {
        const db = await getDb();
        if (!db) return;

        const settings = await db.collection('guildsettings').findOne({ guildId: message.guild.id });
        if (settings && settings.moderationEnabled === false) return;

        const commandDocs = await db.collection('moderationcommands')
            .find({ guildId: message.guild.id })
            .toArray();

        const parts = message.content.trim().split(/\s+/);
        const firstWord = parts[0]?.toLowerCase();
        if (!firstWord) return;

        const matched = commandDocs.find(cmd =>
            cmd.enabled !== false &&
            (cmd.aliases || []).some(a => a.toLowerCase() === firstWord)
        );
        if (!matched) return;

        if (!checkPermissions(matched, message.member, message.channel.id)) return;

        const args = parts.slice(1);
        const targetMember = message.mentions.members?.first();
        const reasonWords = args.filter(a => !a.startsWith('<@'));

        switch (matched.commandKey) {
            case 'ban': return await runBan(message, targetMember, reasonWords.join(' '));
            case 'kick': return await runKick(message, targetMember, reasonWords.join(' '));
            case 'unban': return await runUnban(message, args[0]);
            case 'timeout': return await runTimeout(message, targetMember, args[1], args.slice(2).join(' '));
            case 'untimeout': return await runUntimeout(message, targetMember);
            case 'lock': return await runLock(message);
            case 'unlock': return await runUnlock(message);
            case 'warn': return await runWarn(message, db, targetMember, reasonWords.join(' '));
            case 'clear': return await runClear(message, parseInt(args[0]));
            case 'unwarn': return await runUnwarn(message, db, targetMember);
            case 'warns': return await runWarns(message, db, targetMember);
            case 'addrole': return await runAddrole(message, targetMember, message.mentions.roles?.first());
            case 'deleteroles': return await runDeleterole(message, targetMember, message.mentions.roles?.first());
            case 'nickname': return await runNickname(message, targetMember, args.slice(1).join(' '));
        }
    } catch (err) {
        console.error('❌ خطأ في نظام أوامر الإشراف (الداشبورد):', err);
    }
}

async function runBan(message, targetMember, reason) {
    if (!targetMember) return reply(message, '❌ لازم تمنشن العضو اللي تبي تحظره');
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return reply(message, '❌ ما عندك صلاحية الحظر');
    await targetMember.ban({ reason: reason || 'بدون سبب' });
    await reply(message, `✅ تم حظر **${targetMember.user.tag}**${reason ? `\nالسبب: ${reason}` : ''}`);
}

async function runKick(message, targetMember, reason) {
    if (!targetMember) return reply(message, '❌ لازم تمنشن العضو اللي تبي تطرده');
    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return reply(message, '❌ ما عندك صلاحية الطرد');
    await targetMember.kick(reason || 'بدون سبب');
    await reply(message, `✅ تم طرد **${targetMember.user.tag}**${reason ? `\nالسبب: ${reason}` : ''}`);
}

async function runUnban(message, userId) {
    if (!userId) return reply(message, '❌ لازم تحط آيدي العضو اللي تبي تفك حظره');
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return reply(message, '❌ ما عندك صلاحية فك الحظر');
    try {
        await message.guild.members.unban(userId);
        await reply(message, `✅ تم فك الحظر عن العضو صاحب الآيدي \`${userId}\``);
    } catch {
        await reply(message, '❌ ما لقيت هذا الآيدي بقائمة المحظورين');
    }
}

async function runTimeout(message, targetMember, durationStr, reason) {
    if (!targetMember) return reply(message, '❌ لازم تمنشن العضو');
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return reply(message, '❌ ما عندك صلاحية الإسكات');
    const ms = parseDuration(durationStr);
    if (!ms) return reply(message, '❌ حط مدة صحيحة مثل: 10m أو 1h أو 1d');
    await targetMember.timeout(ms, reason || 'بدون سبب');
    await reply(message, `✅ تم إسكات **${targetMember.user.tag}** لمدة ${durationStr}${reason ? `\nالسبب: ${reason}` : ''}`);
}

async function runUntimeout(message, targetMember) {
    if (!targetMember) return reply(message, '❌ لازم تمنشن العضو');
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return reply(message, '❌ ما عندك صلاحية');
    await targetMember.timeout(null);
    await reply(message, `✅ تم إلغاء إسكات **${targetMember.user.tag}**`);
}

async function runLock(message) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return reply(message, '❌ ما عندك صلاحية');
    await message.channel.permissionOverwrites.edit(message.guild.id, { SendMessages: false });
    await reply(message, '🔒 تم قفل الروم');
}

async function runUnlock(message) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return reply(message, '❌ ما عندك صلاحية');
    await message.channel.permissionOverwrites.edit(message.guild.id, { SendMessages: true });
    await reply(message, '🔓 تم فتح الروم');
      }
async function runWarn(message, db, targetMember, reason) {
    if (!targetMember) return reply(message, '❌ لازم تمنشن العضو');
    await db.collection('warnings').insertOne({
        guildId: message.guild.id,
        userId: targetMember.id,
        reason: reason || 'بدون سبب',
        moderatorId: message.author.id,
        timestamp: new Date()
    });
    await reply(message, `⚠️ تم تحذير **${targetMember.user.tag}**${reason ? `\nالسبب: ${reason}` : ''}`);
}

async function runUnwarn(message, db, targetMember) {
    if (!targetMember) return reply(message, '❌ لازم تمنشن العضو');
    const last = await db.collection('warnings')
        .find({ guildId: message.guild.id, userId: targetMember.id })
        .sort({ timestamp: -1 }).limit(1).toArray();
    if (!last.length) return reply(message, 'ما عنده تحذيرات أصلاً');
    await db.collection('warnings').deleteOne({ _id: last[0]._id });
    await reply(message, `✅ تم إزالة آخر تحذير عن **${targetMember.user.tag}**`);
}

async function runWarns(message, db, targetMember) {
    const target = targetMember || message.member;
    const list = await db.collection('warnings')
        .find({ guildId: message.guild.id, userId: target.id })
        .sort({ timestamp: -1 }).toArray();

    if (!list.length) return reply(message, `**${target.user.tag}** ما عنده أي تحذير`);

    const embed = new EmbedBuilder()
        .setColor(BRAND_COLOR)
        .setTitle(`تحذيرات ${target.user.tag}`)
        .setDescription(list.map((w, i) => `**${i + 1}.** ${w.reason} — <t:${Math.floor(w.timestamp.getTime() / 1000)}:R>`).join('\n'));
    await message.channel.send({ embeds: [embed] });
}

async function runClear(message, amount) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return reply(message, '❌ ما عندك صلاحية');
    if (!amount || amount < 1 || amount > 100) return reply(message, '❌ حط رقم بين 1 و100');
    await message.channel.bulkDelete(amount + 1, true);
    const sent = await message.channel.send(`🧹 تم حذف ${amount} رسالة`);
    setTimeout(() => sent.delete().catch(() => {}), 3000);
}

async function runAddrole(message, targetMember, role) {
    if (!targetMember || !role) return reply(message, '❌ لازم تمنشن العضو والرول');
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) return reply(message, '❌ ما عندك صلاحية');
    await targetMember.roles.add(role);
    await reply(message, `✅ تم إضافة رول **${role.name}** لـ **${targetMember.user.tag}**`);
}

async function runDeleterole(message, targetMember, role) {
    if (!targetMember || !role) return reply(message, '❌ لازم تمنشن العضو والرول');
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) return reply(message, '❌ ما عندك صلاحية');
    await targetMember.roles.remove(role);
    await reply(message, `✅ تم إزالة رول **${role.name}** من **${targetMember.user.tag}**`);
}

async function runNickname(message, targetMember, newNick) {
    if (!targetMember) return reply(message, '❌ لازم تمنشن العضو');
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageNicknames)) return reply(message, '❌ ما عندك صلاحية');
    await targetMember.setNickname(newNick || null);
    await reply(message, `✅ تم تغيير اسم **${targetMember.user.tag}** إلى **${newNick || targetMember.user.username}**`);
}

module.exports = { handleMessage };
